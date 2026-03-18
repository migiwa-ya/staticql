import { resolveField } from "./utils/field.js";
import {
  resolveDirectRelation,
  resolveThroughRelation,
  buildForeignKeyMap,
} from "./utils/relationResolver.js";
import {
  ResolvedSourceConfig as RSC,
  SourceConfigResolver as Resolver,
} from "./SourceConfigResolver.js";
import {
  SourceRecord,
  DiffEntry,
  DirectRelationMap,
  ThroughRelationMap,
} from "./types.js";
import { StorageRepository } from "./repository/StorageRepository.js";
import { SourceLoader } from "./SourceLoader";
import { LoggerProvider } from "./logger/LoggerProvider";
import { joinPath, toI, toP, toParent } from "./utils/path.js";
import { mapSetToObject } from "./utils/normalize.js";
import { PrefixIndexLine } from "./utils/typs.js";
import { IIndexReader } from "./IIndexReader.js";
import {
  getPrefixIndexPath,
  isThroughRelation,
  indexSort,
} from "./constants.js";

// Re-export types for backward compatibility
export type { DiffEntry, DirectRelationMap, ThroughRelationMap } from "./types.js";

// Map<sourceName, Map<status, >>
type EntryGroup = Map<
  string,
  Map<DiffEntry["status"], Set<Omit<DiffEntry, "status" | "source">>>
>;

// Record<sourceName, {["foreignMap" | "targetMap"]: Map<value, SourceRecord[]>
type RelationMaps = Record<string, DirectRelationMap | ThroughRelationMap>;

/**
 * IndexBuilder: handles full and incremental index building.
 */
export class IndexBuilder {
  private customIndexers: Record<
    string,
    (value: any, record?: SourceRecord) => any
  > = {};

  constructor(
    private readonly sourceLoader: SourceLoader<SourceRecord>,
    private readonly repository: StorageRepository,
    private readonly resolver: Resolver,
    private readonly logger: LoggerProvider,
    private readonly reader: IIndexReader,
    customIndexers?: Record<string, (value: any, record?: SourceRecord) => any>
  ) {
    if (customIndexers) {
      this.customIndexers = customIndexers;
    }
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

      // Create Prefix Indexes (parallel writes)
      const indexWrites: Promise<void>[] = [];
      for await (const [path, contents] of Array.from(entries)) {
        for (const [_, contentEntries] of contents) {
          const raw = contentEntries
            .sort(indexSort())
            .map((c) => JSON.stringify(c))
            .join("\n");

          indexWrites.push(this.repository.writeFile(path, raw));
        }
      }

      // Create dictionary of Prefix Indexes (parallel writes)
      const prefixWrites: Promise<void>[] = [];
      for await (const [_, values] of this.collectPrefixDirs(
        prefixes,
        rsc
      ).entries()) {
        for (const [path, value] of values) {
          const raw = [...value].join("\n");

          prefixWrites.push(this.repository.writeFile(path, raw));
        }
      }

      await Promise.all([...indexWrites, ...prefixWrites]);
    }
  }

  /**
   * Incrementally updates affected indexes based on diff entries.
   *
   * @param diffEntries - List of file change entries.
   */
  async updateIndexesForFiles(diffEntries: DiffEntry[]): Promise<string[]> {
    const entryGroup: EntryGroup = new Map();
    const touched: string[] = [];

    for (const entry of diffEntries) {
      if (entry.status === "A" || entry.status === "D") {
        if (!entryGroup.has(entry.source))
          entryGroup.set(entry.source, new Map());
        const source = entryGroup.get(entry.source);
        if (!source?.has(entry.status)) source?.set(entry.status, new Set());
        source?.get(entry.status)?.add({ slug: entry.slug });
      }
    }

    const diffMap = new Map<string, Map<string, DiffEntry>>();
    for (const e of diffEntries) {
      if (!diffMap.has(e.source)) diffMap.set(e.source, new Map());
      diffMap.get(e.source)!.set(e.slug, e);
    }

    const dataMap = new Map<string, Set<SourceRecord>>();

    for (const [source, entries] of entryGroup.entries()) {
      const rsc = this.resolver.resolveOne(source);
      if (!rsc.indexes) continue;

      /* --- 1. D / A+M を分離 ------------------------------------ */
      const addOrMod = entries.get("A") ?? new Set();
      (entries.get("M") ?? new Set()).forEach((p) => addOrMod.add(p));
      const delOnly = entries.get("D") ?? new Set();

      const slugsToLoad = [...addOrMod].map((p) => p.slug);

      /* --- 2. 実ファイルをロード (存在する想定だけ) -------------- */
      const loaded = await this.sourceLoader.loadBySlugs(source, slugsToLoad);

      if (!dataMap.has(rsc.name)) dataMap.set(rsc.name, new Set());

      /* 2-A. 取得できたレコードはそのまま */
      loaded.forEach((rec) => dataMap.get(rsc.name)!.add(rec));

      const loadedSlugs = new Set(loaded.map((r) => r.slug));

      /* 2-B. 取得できなかった slug は擬似レコード */
      for (const slug of slugsToLoad) {
        if (loadedSlugs.has(slug)) continue; // 取れている
        const diff = diffMap.get(source)!.get(slug);
        if (!diff) continue; // 保険
        dataMap.get(rsc.name)!.add(makePseudo(diff));
      }

      /* --- 3. 削除 (D) は必ず擬似レコード ----------------------- */
      for (const { slug } of delOnly) {
        const diff = diffMap.get(source)!.get(slug);
        if (!diff) continue;
        dataMap.get(rsc.name)!.add(makePseudo(diff));
      }
    }

    function makePseudo(diff: DiffEntry): SourceRecord {
      return { slug: diff.slug, ...diff.fields } as SourceRecord;
    }

    const relationMaps: RelationMaps = {};
    for (const [sourceName, data] of dataMap) {
      const rsc = this.resolver.resolveOne(sourceName);
      const relations = rsc.relations ?? [];

      for (const [key, rel] of Object.entries(relations)) {
        if (isThroughRelation(rel)) {
          // is through relation

          if (!dataMap.get(rel.to)) {
            let through = dataMap.get(rel.through);
            if (!through) {
              const prefixIndexLine = (
                await Promise.all(
                  [...data].map((s) =>
                    this.reader.findIndexLines(
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
                throw new Error(
                  `[${rsc.name}] failed to find index lines for through relation: source=${rel.through}, field=${rel.throughForeignKey}`
                );

              // extracts reference slugs
              const slugs = prefixIndexLine
                .map((i) => Object.keys(i?.ref))
                .flat();

              through = new Set(
                await this.sourceLoader.loadBySlugs(rel.through, slugs)
              );

              if (!through.size) {
                throw new Error(
                  `[${rsc.name}] is trying to relate to a non-existent [${rel.to}] source via [${rel.through}], or there is an inconsistency in the index. Please check and correct the existence of the difference file and source file, or rebuild the index.`
                );
              }

              dataMap.set(rel.through, through);
            }

            let to = dataMap.get(rel.to);
            if (!to) {
              const prefixIndexLine = (
                await Promise.all(
                  [...through].map((s) =>
                    this.reader.findIndexLines(
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
                .map((i) => Object.keys(i?.ref))
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
          // is direct relation

          if (!dataMap.get(rel.to)) {
            const localKeys = [...data]
              .map((s): string[] => resolveField(s, rel.localKey))
              .flat();
            const prefixIndexLine = (
              await Promise.all(
                localKeys.map((k) =>
                  this.reader.findIndexLines(rel.to, rel.foreignKey, k)
                )
              )
            )
              .flat()
              .filter((i): i is PrefixIndexLine => !!i);

            // extracts reference slugs
            const slugs = prefixIndexLine
              .map((i) => Object.keys(i?.ref))
              .flat();

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
          if (isThroughRelation(rel)) {
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
        let data: Set<PrefixIndexLine> = new Set();
        if (await this.repository.exists(path)) {
          const existedRaw = await this.repository.readFile(path);
          data = new Set(existedRaw.split("\n").map((raw) => JSON.parse(raw)));
        }

        for (const [status, contentEntries] of contents) {
          for (const c of contentEntries) {
            if (status === "A") {
              const same = [...data].find((e) => e.v === c.v && e.vs === c.vs);
              if (same) {
                same.ref = { ...same.ref, ...c.ref };
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
              .sort(indexSort())
              .map((c) => JSON.stringify(c))
              .join("\n");

            if (!raw.length) {
              this.repository.removeDir(toParent(path));
              touched.push(path);
            } else {
              this.repository.writeFile(path, raw);
              touched.push(path);
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
              touched.push(path);
            } else {
              const raw = [...value]
                .sort((a, b) => a.localeCompare(b))
                .map((c) => c)
                .join("\n");

              this.repository.writeFile(path, raw);
              touched.push(path);
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
              touched.push(path);
            } else {
              const raw = [...existed].join("\n");

              await this.repository.writeFile(path, raw);
              touched.push(path);
            }
          }
        }
      }
    }

    return touched;
  }

  /**
   * Builds indexable records for a single source (with joined relations).
   */
  private async buildRecords(rsc: RSC) {
    const relations = rsc.relations ?? {};

    const sourceNames = new Set<string>([rsc.name]);
    for (const rel of Object.values(relations)) {
      if (isThroughRelation(rel)) {
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
      if (isThroughRelation(rel)) {
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

      // resolve relations
      for (const [key, rel] of Object.entries(relations)) {
        if (isThroughRelation(rel)) {
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
          const prefix = getPrefixIndexPath(
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
            const root = getPrefixIndexPath(value, indexConfig.depth);
            const path = toI(indexConfig.dir, root);

            const status = entryGroup
              ? this.getStatus(entryGroup, rsc.name, slug)
              : "A";

            const entry = {
              v: value,
              vs: refSlug,
              ref: mapSetToObject(new Map([[slug, prefixes.get(slug)!]])),
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

    if (!rsc.indexes) throw new Error(`[${rsc.name}] has no indexes configured`);

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
   * Get incremental index entry status.
   */
  private getStatus(diffMap: EntryGroup, sourceName: string, slug: string) {
    const statusMap = diffMap.get(sourceName);
    if (!statusMap)
      throw new Error(
        `[${sourceName}] is not found in diff entries`
      );

    let result: DiffEntry["status"] | null = null;

    for (const [status, entries] of statusMap.entries()) {
      for (const entry of entries) {
        if (entry.slug === slug) {
          result = status;
        }
      }
    }

    if (!result)
      throw new Error(
        `[${sourceName}] slug "${slug}" is not found in diff entries`
      );

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

    if (rsc.indexes && this.customIndexers) {
      for (const [customName, _] of Object.entries(rsc.indexes)) {
        if (
          !Object.prototype.hasOwnProperty.call(
            this.customIndexers,
            `${rsc.name}.${customName}`
          )
        )
          continue;

        try {
          const callback = this.customIndexers[`${rsc.name}.${customName}`];
          const customValue = callback(record);

          if (customValue !== undefined && customValue !== null) {
            if (!values.has(customName)) values.set(customName, new Set());
            const arr = Array.isArray(customValue)
              ? customValue
              : [customValue];
            for (const v of arr) {
              values.get(customName)?.add({ value: v, refSlug: record.slug });
            }
          }
        } catch (e) {
          this.logger?.warn?.(
            `[IndexBuilder] Custom indexer for "${customName}" threw error: ${e}`
          );
        }
      }
    }

    return { slug: record.slug, values };
  }
}
