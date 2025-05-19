import { resolveField } from "./utils/field.js";
import {
  resolveDirectRelation,
  resolveThroughRelation,
  buildForeignKeyMap,
} from "./utils/relationResolver.js";
import {
  Relation,
  ResolvedSourceConfig as RSC,
  SourceConfigResolver as Resolver,
  SourceRecord,
  ThroughRelation,
} from "./SourceConfigResolver.js";
import { StorageRepository } from "./repository/StorageRepository.js";
import { SourceLoader } from "./SourceLoader";
import { LoggerProvider } from "./logger/LoggerProvider";
import { joinPath, tail, toI, toP, toParent } from "./utils/path.js";
import { readJsonlStream, readListStream } from "./utils/stream.js";
import { mapSetToObject } from "./utils/normalize.js";
import { PrefixIndexDepth, PrefixIndexLine } from "./utils/typs.js";
import { decodeCursor } from "./utils/pagenation.js";
import { cacheAsyncGen } from "./utils/cache.js";
import { CacheProvider } from "./cache/CacheProvider.js";
import { InMemoryCacheProvider } from "./cache/InMemoryCacheProvider.js";

// represents a file diff entry (for incremental index updates).
export type DiffEntry = { status: "A" | "D"; source: string; slug: string };
// TODO: M, R statuses
// | { status: "M"; source: string; slug: string; field: string }
// | { status: "R"; source: string; slug: string; oldSlug: string };

// Map<sourceName, Map<status, >>
type EntryGroup = Map<
  string,
  Map<DiffEntry["status"], Set<Omit<DiffEntry, "status" | "source">>>
>;

// Record<sourceName, {["foreignMap" | "targetMap"]: Map<value, SourceRecord[]>
type RelationMaps = Record<string, DirectRelationMap | ThroughRelationMap>;
export type DirectRelationMap = { foreignMap: Map<string, SourceRecord[]> };
export type ThroughRelationMap = {
  targetMap: Map<string, SourceRecord[]>;
  throughMap: Map<string, SourceRecord[]>;
};

/**
 * Indexer: core class for building and updating search indexes.
 */
export class Indexer {
  public static indexPrefix = "index";
  public static indexDepth: PrefixIndexDepth = 2;

  private cache: CacheProvider;

  constructor(
    private readonly sourceLoader: SourceLoader<SourceRecord>,
    private readonly repository: StorageRepository,
    private readonly resolver: Resolver,
    private readonly logger: LoggerProvider
  ) {
    this.cache = new InMemoryCacheProvider();
  }

  /**
   * Saves indexes and slug lists for all sources.
   *
   * @throws Error if writing to storage fails.
   */
  async save(): Promise<void> {
    for (const rsc of this.resolver.resolveAll()) {
      if (!rsc.indexes) continue;

      const records = await this.buildRecords(rsc);

      const prefixes = this.getPrefixIndexPathByResolvedRecords(
        records,
        rsc.indexes
      );

      const entries = this.createIndexLines(records, prefixes, rsc);

      // Create Prefix Indexes
      for await (const [path, contents] of Array.from(entries)) {
        for (const [_, contentEntries] of contents) {
          const raw = contentEntries
            .sort(this.indexSort())
            .map((c) => JSON.stringify(c))
            .join("\n");

          this.repository.writeFile(path, raw);
        }
      }

      // Create dictionary of Prefix Indexes
      for await (const [_, values] of this.collectPrefixDirs(
        prefixes,
        rsc
      ).entries()) {
        for (const [path, value] of values) {
          const raw = [...value].join("\n");

          this.repository.writeFile(path, raw);
        }
      }
    }
  }

  /**
   * Incrementally updates affected indexes based on diff entries.
   *
   * @param diffEntries - List of file change entries.
   */
  async updateIndexesForFiles(diffEntries: DiffEntry[]): Promise<void> {
    const entryGroup: EntryGroup = new Map();

    for (const entry of diffEntries) {
      if (entry.status === "A" || entry.status === "D") {
        if (!entryGroup.has(entry.source))
          entryGroup.set(entry.source, new Map());
        const source = entryGroup.get(entry.source);
        if (!source?.has(entry.status)) source?.set(entry.status, new Set());
        source?.get(entry.status)?.add({ slug: entry.slug });
      }
    }

    const dataMap = new Map<string, Set<SourceRecord>>();
    for (const [source, entries] of entryGroup.entries()) {
      const rsc = this.resolver.resolveOne(source);

      // unnecessary creat index
      if (!rsc.indexes) continue;

      for (const [_, payloads] of entries.entries()) {
        const slugs = [...payloads].map((p) => p.slug);
        const sources = await this.sourceLoader.loadBySlugs(source, slugs);

        if (!dataMap.has(rsc.name)) dataMap.set(rsc.name, new Set());
        sources.map((s) => dataMap.get(rsc.name)?.add(s));
      }
    }

    const relationMaps: RelationMaps = {};
    for (const [sourceName, data] of dataMap) {
      const rsc = this.resolver.resolveOne(sourceName);
      const relations = rsc.relations ?? [];

      for (const [key, rel] of Object.entries(relations)) {
        if (this.isThroughRelation(rel)) {
          if (!dataMap.get(rel.to)) {
            let through = dataMap.get(rel.through);
            if (!through) {
              const prefixIndexLine = (
                await Promise.all(
                  [...data].map((s) =>
                    this.findIndexLines(
                      rel.through,
                      rel.throughForeignKey,
                      s[rel.sourceLocalKey]
                    )
                  )
                )
              )
                .flat()
                .filter((i): i is PrefixIndexLine => !!i);

              if (!prefixIndexLine || !prefixIndexLine.length)
                throw new Error();

              // extracts reference slugs
              const slugs = prefixIndexLine
                .map((i) => Object.keys(i?.r))
                .flat();

              through = new Set(
                await this.sourceLoader.loadBySlugs(rel.through, slugs)
              );

              if (!through.size) {
                throw new Error(
                  `[${rsc.name}] is trying to relate to a non-existent [${rel.to}] source, or there is an inconsistency in the index. Please check and correct the existence of the difference file and source file, or rebuild the index.`
                );
              }

              dataMap.set(rel.through, through);
            }

            let to = dataMap.get(rel.to);
            if (!to) {
              const prefixIndexLine = (
                await Promise.all(
                  [...through].map((s) =>
                    this.findIndexLines(
                      rel.to,
                      rel.targetForeignKey,
                      s[rel.throughLocalKey]
                    )
                  )
                )
              )
                .flat()
                .filter((i): i is PrefixIndexLine => !!i);

              // extracts reference slugs
              const slugs = prefixIndexLine
                .map((i) => Object.keys(i?.r))
                .flat();

              to = new Set(await this.sourceLoader.loadBySlugs(rel.to, slugs));

              if (!to.size) {
                throw new Error(
                  `[${rsc.name}] is trying to relate to a non-existent [${rel.to}] source, or there is an inconsistency in the index. Please check and correct the existence of the difference file and source file, or rebuild the index.`
                );
              }

              dataMap.set(rel.to, to);
            }
          }

          relationMaps[key] = {
            targetMap: buildForeignKeyMap(
              [...dataMap.get(rel.to)!],
              rel.targetForeignKey
            ),
            throughMap: buildForeignKeyMap(
              [...dataMap.get(rel.through)!],
              rel.throughForeignKey
            ),
          };
        } else {
          if (!dataMap.get(rel.to)) {
            const localKeys = [...data]
              .map((s): string[] =>
                Array.isArray(s[rel.localKey])
                  ? s[rel.localKey]
                  : [s[rel.localKey]]
              )
              .flat();
            const prefixIndexLine = (
              await Promise.all(
                localKeys.map((k) =>
                  this.findIndexLines(rel.to, rel.foreignKey, k)
                )
              )
            )
              .flat()
              .filter((i): i is PrefixIndexLine => !!i);

            // extracts reference slugs
            const slugs = prefixIndexLine.map((i) => Object.keys(i?.r)).flat();

            const to = new Set(
              await this.sourceLoader.loadBySlugs(rel.to, slugs)
            );

            if (!to.size) {
              throw new Error(
                `[${rsc.name}] is trying to relate to a non-existent [${rel.to}] source, or there is an inconsistency in the index. Please check and correct the existence of the difference file and source file, or rebuild the index.`
              );
            }

            dataMap.set(rel.to, to);
          }

          relationMaps[key] = {
            foreignMap: buildForeignKeyMap(
              [...dataMap.get(rel.to)!],
              rel.foreignKey
            ),
          };
        }
      }
    }

    for (const [source, _] of entryGroup.entries()) {
      const rsc = this.resolver.resolveOne(source);
      const relations = rsc.relations ?? [];

      if (!rsc.indexes || !relations) continue;

      const records = [...dataMap.get(rsc.name)!].map((row) => {
        const result = { ...row };
        for (const [key, rel] of Object.entries(relations)) {
          if (this.isThroughRelation(rel)) {
            result[key] = resolveThroughRelation(
              row,
              rel,
              [...dataMap.get(rel.through)!],
              [...dataMap.get(rel.to)!],
              (relationMaps[key] as ThroughRelationMap).targetMap,
              (relationMaps[key] as ThroughRelationMap).throughMap
            );
          } else {
            result[key] = resolveDirectRelation(
              row,
              rel,
              [...dataMap.get(rel.to)!],
              (relationMaps[key] as DirectRelationMap).foreignMap
            );
          }
        }
        return result;
      });

      const prefixes = this.getPrefixIndexPathByResolvedRecords(
        records,
        rsc.indexes
      );

      const entries = this.createIndexLines(records, prefixes, rsc, entryGroup);

      for await (const [path, contents] of Array.from(entries)) {
        let data: Set<{ v: string; vs: string; r: object }> = new Set();
        if (await this.repository.exists(path)) {
          const existedRaw = await this.repository.readFile(path);
          data = new Set(existedRaw.split("\n").map((raw) => JSON.parse(raw)));
        }

        for (const [status, contentEntries] of contents) {
          for (const c of contentEntries) {
            if (status === "A") {
              const same = [...data].find((e) => e.v === c.v && e.vs === c.vs);
              if (same) {
                same.r = { ...same.r, ...c.r };
              } else {
                data.add(c);
              }
            } else if (status === "D") {
              const same = [...data].find((e) => e.v === c.v && e.vs === c.vs);
              if (same) {
                data.delete(same);
              }
            }

            const raw = [...data]
              .sort(this.indexSort())
              .map((c) => JSON.stringify(c))
              .join("\n");

            if (!raw.length) {
              this.repository.removeDir(toParent(path));
            } else {
              this.repository.writeFile(path, raw);
            }
          }
        }
      }

      for await (const [status, values] of this.collectPrefixDirs(
        prefixes,
        rsc,
        entryGroup
      ).entries()) {
        for (const [path, value] of values) {
          if (!(await this.repository.exists(path))) continue;

          if (status === "A") {
            if (await this.repository.exists(path)) {
              const existsRaw = await this.repository.readFile(path);
              const existed = new Set(existsRaw.split("\n").map((raw) => raw));
              for (const prefixString of value) {
                existed.add(prefixString);
              }
              const raw = [...existed]
                .sort((a, b) => a.localeCompare(b))
                .map((c) => c)
                .join("\n");

              this.repository.writeFile(path, raw);
            } else {
              const raw = [...value]
                .sort((a, b) => a.localeCompare(b))
                .map((c) => c)
                .join("\n");

              this.repository.writeFile(path, raw);
            }
          } else if (status === "D") {
            const existsRaw = await this.repository.readFile(path);
            const existed = new Set(existsRaw.split("\n").map((raw) => raw));

            for (const prefixString of [...value]) {
              const dir = joinPath(toParent(path), prefixString);
              if (!(await this.repository.exists(dir))) {
                if (existed.has(prefixString)) existed.delete(prefixString);
              }
            }

            if (existed.size === 0) {
              await this.repository.removeDir(toParent(path));
            } else {
              const raw = [...existed].join("\n");

              await this.repository.writeFile(path, raw);
            }
          }
        }
      }
    }
  }

  /**
   * Get PrefixIndexLines for next page.
   */
  async *readForwardPrefixIndexLines(
    rootDir: string,
    pageSize: number = 20,
    cursor?: string,
    orderByKey: string = "slug",
    isDesc: boolean = false
  ) {
    const cursorObject = cursor ? decodeCursor(cursor) : undefined;
    const indexParentDir = cursorObject
      ? joinPath(rootDir, cursorObject.order[orderByKey])
      : isDesc
      ? tail(await this.findLastIndexPath(rootDir)).base
      : tail(await this.findFirstIndexPath(rootDir)).base;

    const targetSlug = cursorObject?.slug;
    let count = 0;
    let countable = !targetSlug;

    const indexWalker = isDesc
      ? this.walkPrefixIndexesUpword
      : this.walkPrefixIndexesDownword;

    const gen = cacheAsyncGen(
      (path: string) => indexWalker.bind(this)(path),
      (path) => path,
      this.cache
    );

    const reverseInFile = isDesc;

    for await (const indexPath of gen(indexParentDir)) {
      for await (const prefixIndexLine of this.readIndexFileLines(
        indexPath,
        reverseInFile
      )) {
        if (!countable && targetSlug) {
          if (
            Object.prototype.hasOwnProperty.call(prefixIndexLine.r, targetSlug)
          ) {
            countable = true;
            continue;
          }
        }
        if (countable) {
          yield prefixIndexLine;
          if (++count >= pageSize) return;
        }
      }
    }
  }

  /**
   * Get PrefixIndexLines for backward pagination.
   */
  async *readBackwardPrefixIndexLines(
    rootDir: string,
    pageSize: number = 20,
    cursor?: string,
    orderByKey: string = "slug",
    isDesc: boolean = false
  ) {
    const cursorObject = cursor ? decodeCursor(cursor) : undefined;
    const indexParentDir = cursorObject
      ? joinPath(rootDir, cursorObject.order[orderByKey])
      : isDesc
      ? tail(await this.findFirstIndexPath(rootDir)).base
      : tail(await this.findLastIndexPath(rootDir)).base;

    const targetSlug = cursorObject?.slug;
    let count = 0;
    let countable = !targetSlug;

    const indexWalker = isDesc
      ? this.walkPrefixIndexesDownword
      : this.walkPrefixIndexesUpword;

    const gen = cacheAsyncGen(
      (path: string) => indexWalker.bind(this)(path),
      (path) => path,
      this.cache
    );

    const reverseInFile = !isDesc;

    for await (const indexPath of gen(indexParentDir)) {
      for await (const prefixIndexLine of this.readIndexFileLines(
        indexPath,
        reverseInFile
      )) {
        if (!countable && targetSlug) {
          if (
            Object.prototype.hasOwnProperty.call(prefixIndexLine.r, targetSlug)
          ) {
            countable = true;
            continue;
          }
        }
        if (countable) {
          yield prefixIndexLine;
          if (++count >= pageSize) return;
        }
      }
    }
  }

  /**
   * Read index file lines.
   */
  async *readIndexFileLines(
    indexPath: string,
    reverse: boolean
  ): AsyncGenerator<PrefixIndexLine> {
    const stream = await this.repository.openFileStream(indexPath);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    if (reverse) {
      // index contents are fixed in ascending order,
      // so they need to be collected once and put in descending order
      const buf: PrefixIndexLine[] = [];
      for await (const line of readJsonlStream<PrefixIndexLine>(
        reader,
        decoder
      )) {
        buf.push(line);
      }
      yield* buf.reverse();
    } else {
      yield* readJsonlStream<PrefixIndexLine>(reader, decoder);
    }
  }

  /**
   * Get the first index of the specified directory.
   */
  private async findFirstIndexPath(dir: string): Promise<string> {
    const prefixIndexPath = toP(dir);

    if (!(await this.repository.exists(prefixIndexPath))) {
      return toI(dir);
    }

    const stream = await this.repository.openFileStream(prefixIndexPath);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    const { value: prefix, done } = await readListStream(
      reader,
      decoder
    ).next();

    return this.findFirstIndexPath(joinPath(dir, prefix));
  }

  /**
   * Get the index of the deepest level below the specified directory.
   */
  private async findLastIndexPath(dir: string): Promise<string> {
    const prefixIndexPath = toP(dir);
    let prefix: string = "";

    if (!(await this.repository.exists(prefixIndexPath))) {
      return toI(dir);
    }

    const stream = await this.repository.openFileStream(prefixIndexPath);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    for await (prefix of readListStream(reader, decoder));

    return this.findLastIndexPath(joinPath(dir, prefix));
  }

  /**
   * Indexes are scanned downward from the specified index directory.
   */
  async *walkPrefixIndexesDownword(
    indexParentDir: string
  ): AsyncGenerator<string> {
    const repository = this.repository;

    // if a path to an index is specified for the first time,
    // disable access to indexes located after it.
    let visitable = false;

    const walk = async function* (
      dir: string,
      visited: Set<string> = new Set()
    ): AsyncGenerator<string> {
      if (!visited.has(toP(dir)) && (await repository.exists(toP(dir)))) {
        const stream = await repository.openFileStream(toP(dir));
        const reader = stream.getReader();
        const decoder = new TextDecoder();

        // record visits that prefixes path
        visited.add(toP(dir));

        // record visits that include index directories
        visited.add(dir);

        for await (let prefix of readListStream(reader, decoder)) {
          if (!visitable && visited.has(joinPath(dir, prefix))) {
            visitable = true;
          }

          if (visitable) {
            yield* walk(joinPath(dir, prefix), visited);
          }
        }
      } else if (
        !visited.has(toI(dir)) &&
        (await repository.exists(toI(dir)))
      ) {
        yield toI(dir);

        // record visits that index path
        visited.add(toI(dir));

        // record visits that include index directories
        visited.add(dir);
      } else {
        // record visits that include index directories
        visited.add(dir);
      }

      if (!visited.has(tail(dir).base)) {
        // reset when ascending a hierarchy to enable skipping in that hierarchy
        visitable = false;

        yield* walk(tail(dir).base, visited);
      }
    };

    yield* walk(indexParentDir, new Set());
  }

  /**
   * Indexes are scanned upward from the specified index directory.
   */
  async *walkPrefixIndexesUpword(indexParentDir: string) {
    const repository = this.repository;

    // if a path to an index is specified for the first time,
    // disable access to indexes located before it.
    let visitable = false;

    const walk = async function* (
      dir: string,
      visited: Set<string> = new Set()
    ): AsyncGenerator<string> {
      if (!visited.has(toP(dir)) && (await repository.exists(toP(dir)))) {
        const stream = await repository.openFileStream(toP(dir));
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        const buff: Set<string> = new Set();

        // record visits that prefixes path
        visited.add(toP(dir));

        // record visits that include index directories
        visited.add(dir);

        // buffer for desc
        for await (const prefix of readListStream(reader, decoder)) {
          buff.add(prefix);
        }

        for (const prefix of [...buff].reverse()) {
          if (!visitable && visited.has(joinPath(dir, prefix))) {
            visitable = true;
          }

          if (visitable) {
            yield* walk(joinPath(dir, prefix), visited);
          }
        }
      } else if (
        !visited.has(toI(dir)) &&
        (await repository.exists(toI(dir)))
      ) {
        yield toI(dir);

        // record visits that index path
        visited.add(toI(dir));

        // record visits that include index directories
        visited.add(dir);
      } else {
        // record visits that include index directories
        visited.add(dir);
      }

      if (!visited.has(tail(dir).base)) {
        // reset when ascending a hierarchy to enable skipping in that hierarchy
        visitable = false;

        yield* walk(tail(dir).base, visited);
      }
    };

    yield* walk(indexParentDir, new Set());
  }

  /**
   *
   * @param unflattened
   * @returns
   */
  flatPrefixIndexLine(unflattened: PrefixIndexLine[]) {
    const seen = new Set<string>();
    const flattened: PrefixIndexLine[] = [];

    for (const item of unflattened) {
      for (const [key, value] of Object.entries(item.r)) {
        if (!seen.has(key)) {
          seen.add(key);
          flattened.push({
            v: item.v,
            vs: item.vs,
            r: { [key]: value },
          });
        }
      }
    }

    return flattened;
  }

  /**
   * Builds indexable records for a single source (with joined relations).
   */
  private async buildRecords(rsc: RSC) {
    const relations = rsc.relations ?? {};

    const sourceNames = new Set<string>([rsc.name]);
    for (const rel of Object.values(relations)) {
      if (this.isThroughRelation(rel)) {
        sourceNames.add(rel.through);
        sourceNames.add(rel.to);
      } else {
        sourceNames.add(rel.to);
      }
    }

    const loadedArrays = await Promise.all(
      Array.from(sourceNames).map((sourceName) =>
        this.sourceLoader.loadBySourceName(sourceName)
      )
    );
    const dataMap = Array.from(sourceNames).reduce<
      Record<string, SourceRecord[]>
    >((acc, key, i) => ((acc[key] = loadedArrays[i]), acc), {});

    // create pre-cache for relation map
    const relationMaps: RelationMaps = {};
    for (const [key, rel] of Object.entries(relations)) {
      if (this.isThroughRelation(rel)) {
        relationMaps[key] = {
          targetMap: buildForeignKeyMap(dataMap[rel.to], rel.targetForeignKey),
          throughMap: buildForeignKeyMap(
            dataMap[rel.through],
            rel.throughForeignKey
          ),
        };
      } else {
        relationMaps[key] = {
          foreignMap: buildForeignKeyMap(dataMap[rel.to], rel.foreignKey),
        };
      }
    }

    const records = dataMap[rsc.name].map((row) => {
      const result = { ...row };
      for (const [key, rel] of Object.entries(relations)) {
        if (this.isThroughRelation(rel)) {
          result[key] = resolveThroughRelation(
            row,
            rel,
            dataMap[rel.through],
            dataMap[rel.to],
            (relationMaps[key] as ThroughRelationMap).targetMap,
            (relationMaps[key] as ThroughRelationMap).throughMap
          );
        } else {
          result[key] = resolveDirectRelation(
            row,
            rel,
            dataMap[rel.to],
            (relationMaps[key] as DirectRelationMap).foreignMap
          );
        }
      }
      return result;
    });

    return records;
  }

  /**
   * Organize the prefix directory paths for each index file location from resolved records.
   */
  private getPrefixIndexPathByResolvedRecords(
    records: SourceRecord[],
    indexes: NonNullable<RSC["indexes"]>
  ): Map<string, Map<string, Set<string>>> {
    const indexFields = Array.from(new Set(Object.keys(indexes)));
    const prefixes = new Map<string, Map<string, Set<string>>>();

    for (const record of records) {
      const paths = new Map<string, Set<string>>();
      for (const field of indexFields) {
        const fieldValues = resolveField(record, field);
        for (const fieldValue of fieldValues) {
          const prefix = this.getPrefixIndexPath(
            fieldValue,
            indexes[field].depth
          );

          if (!paths.get(field)) paths.set(field, new Set());
          paths.get(field)?.add(prefix);
        }
      }
      prefixes.set(record.slug, paths);
    }

    return prefixes;
  }

  /**
   * Organize the map of search keys for the PrefixIndexLine.
   */
  private createIndexLines(
    records: SourceRecord[],
    prefixes: Map<string, Map<string, Set<string>>>,
    rsc: RSC,
    entryGroup?: EntryGroup
  ) {
    if (!rsc.indexes) return [];

    const indexFields = Object.keys(rsc.indexes);

    const rawPrefixIndexLines = records.map((record) =>
      this.extractIndexField(record, rsc)
    );

    const slugsPerFieldKeys = new Map<
      string,
      Map<
        string,
        Map<
          string, // value
          Map<string, true> // refSlug → true
        >
      >
    >();

    for (const line of rawPrefixIndexLines) {
      if (!slugsPerFieldKeys.has(line.slug)) {
        slugsPerFieldKeys.set(line.slug, new Map());
      }
      const slugMap = slugsPerFieldKeys.get(line.slug)!;

      for (const field of indexFields) {
        if (!slugMap.has(field)) {
          slugMap.set(field, new Map());
        }
        const fieldMap = slugMap.get(field)!;

        const indexValueSlugs = line.values.get(field);
        if (!indexValueSlugs) continue;

        for (const { value, refSlug } of indexValueSlugs) {
          const values = Array.isArray(value) ? value : [value];

          for (const v of values) {
            if (!fieldMap.has(v)) {
              fieldMap.set(v, new Map());
            }
            fieldMap.get(v)!.set(refSlug, true);
          }
        }
      }
    }

    // if the reference destination 'vs' (value slug) is different, even if 'v' (value) is the same, it will be a different index.
    const entriesByStatus = new Map<
      string, // path
      Map<DiffEntry["status"], PrefixIndexLine[]>
    >();

    for (const [slug, fieldMap] of slugsPerFieldKeys) {
      for (const [fieldName, valueMap] of fieldMap) {
        for (const [value, refMap] of valueMap) {
          for (const [refSlug] of refMap) {
            const indexConfig = rsc.indexes[fieldName];
            const root = this.getPrefixIndexPath(value, indexConfig.depth);
            const path = toI(indexConfig.dir, root);

            const status = entryGroup
              ? this.getStatus(entryGroup, rsc.name, slug)
              : "A";

            const entry = {
              v: value,
              vs: refSlug,
              r: mapSetToObject(new Map([[slug, prefixes.get(slug)!]])),
            };

            if (!entriesByStatus.has(path)) {
              entriesByStatus.set(path, new Map());
            }

            const statusMap = entriesByStatus.get(path)!;

            if (!statusMap.has(status)) {
              statusMap.set(status, []);
            }

            statusMap.get(status)!.push(entry);
          }
        }
      }
    }

    return entriesByStatus;
  }

  /**
   * Get converted PrefixIndex paths.
   */
  private collectPrefixDirs(
    data: Map<string, Map<string, Set<string>>>,
    rsc: RSC,
    entryGroup?: Map<string, Map<DiffEntry["status"], Set<{ slug: string }>>>
  ): Map<string, Map<string, Set<string>>> {
    const result = new Map<string, Map<string, Set<string>>>();

    if (!rsc.indexes) throw new Error("");

    for (const [slug, fieldMap] of data.entries()) {
      const status = entryGroup
        ? this.getStatus(entryGroup, rsc.name, slug)
        : "A";

      for (const [fieldName, prefixes] of fieldMap.entries()) {
        const indexConfig = rsc.indexes[fieldName];
        for (const prefix of prefixes) {
          const parts = prefix.split("/");

          let path = indexConfig.dir;
          for (let i = 0; i < parts.length; i++) {
            const dir = parts[i];

            if (!result.has(status)) {
              result.set(status, new Map());
            }

            const dirs = result.get(status)!;

            if (!dirs.has(path)) {
              dirs.set(path, new Set());
            }

            dirs.get(path)!.add(dir);

            path += dir + "/";
          }
        }
      }
    }

    // convert to prefix index file path list
    const final = new Map<string, Map<string, Set<string>>>();
    for (const [status, dirMap] of result.entries()) {
      const reversedMap = new Map(Array.from(dirMap).reverse());

      const out = new Map<string, Set<string>>();
      for (const [dir, items] of reversedMap.entries()) {
        out.set(
          toP(dir),
          new Set([...items].sort((a, b) => a.localeCompare(b)))
        );
      }
      final.set(status, out);
    }

    return final;
  }

  /**
   * Get increametal index entry status.
   */
  private getStatus(diffMap: EntryGroup, sourceName: string, slug: string) {
    const statusMap = diffMap.get(sourceName);
    if (!statusMap) throw new Error(`[${sourceName}] is not found`);

    let result: DiffEntry["status"] | null = null;

    for (const [status, entries] of statusMap.entries()) {
      for (const entry of entries) {
        if (entry.slug === slug) {
          result = status;
        }
      }
    }

    if (!result) throw new Error(`[${sourceName}] is not found`);

    return result;
  }

  /**
   * Extract index field from SourceRecord.
   */
  private extractIndexField(record: SourceRecord, rsc: RSC) {
    const indexFields = Object.keys(rsc.indexes ?? {});
    const values: Map<
      string,
      Set<{ value: string; refSlug: string }>
    > = new Map();
    for (const field of indexFields) {
      let valueArr = resolveField(record, field);

      let valueSlugs = new Array(valueArr.length).fill(record.slug);
      const ref = field.split(".").shift() ?? "";
      if (rsc.relations?.hasOwnProperty(ref)) {
        valueSlugs = resolveField(record, `${ref}.slug`);
      }

      for (let i = 0; valueArr.length > i; i++) {
        if (valueArr[i] != null || valueSlugs[i] != null) {
          if (!values.has(field)) values.set(field, new Set());
          values
            .get(field)
            ?.add({ value: valueArr[i], refSlug: valueSlugs[i] });
        }
      }
    }

    return { slug: record.slug, values };
  }

  /**
   * Determines whether the relation is a through-type.
   */
  private isThroughRelation(rel: Relation): rel is ThroughRelation {
    return (
      typeof rel === "object" &&
      "through" in rel &&
      (rel.type === "hasOneThrough" || rel.type === "hasManyThrough")
    );
  }

  /**
   * Get Prefix Index directories path converted with Unicode.
   */
  private getPrefixIndexPath(value: string, depth: number): string {
    const codes = [...value]
      .slice(0, depth)
      .map((char) => char.charCodeAt(0).toString(16).padStart(4, "0"));

    return joinPath(...codes);
  }

  /** Returns the path to the prefixes index dir. */
  static getIndexDir(sourceName: string, field: string): string {
    return `${this.indexPrefix}/${sourceName}.${field}/`;
  }

  /**
   * Get Prefix Index file path converted with Unicode.
   */
  private getIndexPath(sourceName: string, field: string, value: string) {
    const rsc = this.resolver.resolveOne(sourceName);
    if (!rsc.indexes) return null;

    const config = rsc.indexes[field];
    const prefix = this.getPrefixIndexPath(value, config.depth);
    const indexPath = toI(config.dir, prefix);

    return indexPath;
  }

  /**
   * Find PrefixIndexLine list with stream.
   */
  async findIndexLines(
    sourceName: string,
    field: string,
    value: string,
    filterCallback = (indexValue: string, argValue: string) =>
      indexValue === argValue
  ): Promise<null | PrefixIndexLine[]> {
    const rsc = this.resolver.resolveOne(sourceName);
    if (!rsc.indexes) return null;

    const indexPath = this.getIndexPath(sourceName, field, value);
    if (!indexPath) return null;

    if (!(await this.repository.exists(indexPath))) return null;

    const repository = this.repository;

    async function* find(indexPath: string, value: string) {
      const stream = await repository.openFileStream(indexPath);
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      let found: boolean | null = null;

      for await (const entry of readJsonlStream<PrefixIndexLine>(
        reader,
        decoder
      )) {
        if (filterCallback(entry.v, value)) {
          yield entry;
          found = true;
        } else if (found === true) {
          found = false;
        }
        if (found === false) {
          await reader.cancel();
          break;
        }
      }
    }

    const gen = cacheAsyncGen(
      (...args: [string, string]) => find(...args),
      (...args) => args.join("_"),
      this.cache
    );

    const result = await Array.fromAsync(gen(indexPath, value));

    return this.flatPrefixIndexLine(result);
  }

  /**
   * Sort PrefixIndexLine.
   */
  private indexSort<T>(keys: (keyof T)[] = ["v", "vs"] as (keyof T)[]) {
    return (a: T, b: T) => {
      for (const key of keys) {
        const aVal = a[key];
        const bVal = b[key];
        if (typeof aVal === "string" && typeof bVal === "string") {
          const result = aVal.localeCompare(bVal);
          if (result !== 0) return result;
        } else if (aVal !== bVal) {
          return aVal < bVal ? -1 : 1;
        }
      }
      return 0;
    };
  }
}
