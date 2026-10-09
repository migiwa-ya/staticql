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
  compareOrdinal,
} from "./constants.js";

// Re-export types for backward compatibility
export type { DiffEntry, DirectRelationMap, ThroughRelationMap } from "./types.js";

type EntryGroup = Map<
  string,
  Map<"A" | "D", Set<{ slug: string }>>
>;

// Record<sourceName, {["foreignMap" | "targetMap"]: Map<value, SourceRecord[]>
type RelationMaps = Record<string, DirectRelationMap | ThroughRelationMap>;

type IncrementalDirectView = DirectRelationMap & { targets: SourceRecord[] };
type IncrementalThroughView = ThroughRelationMap & {
  throughRecords: SourceRecord[];
  toRecords: SourceRecord[];
};
type IncrementalView = IncrementalDirectView | IncrementalThroughView;
type IncrementalRelationData = Map<
  string,
  Map<string, { A: IncrementalView; D: IncrementalView }>
>;

const PSEUDO_FIELDS = Symbol("pseudoFields");

class IndexValueTerminal {
  constructor(readonly values: string[]) {}
}

function resolveIndexValues(
  record: SourceRecord,
  field: string,
  relations: RSC["relations"]
): string[] {
  const segments = field.split(".");
  const normalize = (value: unknown): string[] =>
    (Array.isArray(value) ? value.flat(Infinity) : [value])
      .filter((item) => item !== undefined && item !== null)
      .map((item) => String(item));
  let values: any[] = [record];

  for (let offset = 0; offset < segments.length; offset++) {
    const remainingPath = segments.slice(offset).join(".");
    const preparePseudo = (node: any): any => {
      if (node instanceof IndexValueTerminal || node == null || typeof node !== "object") {
        return node;
      }
      const pseudoFields = (node as SourceRecord & {
        [PSEUDO_FIELDS]?: Record<string, unknown>;
      })[PSEUDO_FIELDS];
      const isRootRelation = node === record && offset === 0 &&
        Object.prototype.hasOwnProperty.call(relations ?? {}, segments[0]);
      if (
        !pseudoFields || isRootRelation ||
        resolveField(node, remainingPath).length > 0 ||
        !Object.prototype.hasOwnProperty.call(pseudoFields, remainingPath)
      ) return node;
      return new IndexValueTerminal(normalize(pseudoFields[remainingPath]));
    };

    values = values.map((value) => {
      if (value instanceof IndexValueTerminal) return value;
      return Array.isArray(value)
        ? value.map((item) => preparePseudo(item))
        : preparePseudo(value);
    });

    const segment = segments[offset];
    values = values.map((value) => {
      if (value instanceof IndexValueTerminal) return value;
      return Array.isArray(value)
        ? value.map((item) => item instanceof IndexValueTerminal ? item : item?.[segment])
        : value?.[segment];
    }).flat().filter((value) => value instanceof IndexValueTerminal || (value !== undefined && value !== null));
  }

  return values.flat(Infinity).flatMap((value) =>
    value instanceof IndexValueTerminal
      ? value.values
      : value === undefined || value === null ? [] : [String(value)]
  );
}

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

      const prefixes = this.getPrefixIndexPathByResolvedRecords(records, rsc);

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
      for await (const [path, value] of this.collectPrefixDirs(prefixes, rsc)) {
        const raw = [...value].join("\n");

        prefixWrites.push(this.repository.writeFile(path, raw));
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
    const originalEntries = [...diffEntries];
    const allSourceConfigs = this.resolver.resolveAll();
    const affectedSlugs = new Map<string, Set<string>>();
    const throughRecordsBySource = new Map<string, Promise<SourceRecord[]>>();
    const sourceSlugsByName = new Map<string, Promise<Set<string>>>();
    const uniqueValues = (values: unknown[]): string[] =>
      [...new Set(
        values.flat(Infinity).filter((value) => value != null).map(String)
      )];
    const entryValues = (entry: DiffEntry, field: string): string[] => {
      if (field === "slug") return [entry.slug];
      const values = [entry.fields?.[field]];
      if (entry.status === "M") values.push(entry.oldFields?.[field]);
      return uniqueValues(values);
    };
    const addAffectedSlugs = (source: string, slugs: string[]) => {
      if (!affectedSlugs.has(source)) affectedSlugs.set(source, new Set());
      for (const slug of slugs) affectedSlugs.get(source)!.add(slug);
    };
    const findReferencingSlugs = async (
      source: string,
      localKey: string,
      keys: string[]
    ): Promise<string[]> => {
      if (localKey === "slug") {
        if (!sourceSlugsByName.has(source)) {
          sourceSlugsByName.set(
            source,
            this.sourceLoader.loadBySourceName(source).then(
              (records) => new Set(records.map((record) => record.slug))
            )
          );
        }
        const currentSlugs = await sourceSlugsByName.get(source)!;
        return keys.filter((slug) => currentSlugs.has(slug));
      }
      const lines = await Promise.all(
        keys.map((key) => this.reader.findIndexLines(source, localKey, key))
      );
      return [...new Set(
        lines.flatMap((result) =>
          (result ?? []).flatMap((line) => Object.keys(line.ref))
        )
      )];
    };

    // Any changed target can affect the resolved relation of existing rows.
    for (const entry of originalEntries) {
      for (const sourceRsc of allSourceConfigs) {
        for (const rel of Object.values(sourceRsc.relations ?? {})) {
          if (isThroughRelation(rel)) {
            if (rel.through === entry.source) {
              const keys = entryValues(entry, rel.throughForeignKey);
              addAffectedSlugs(
                sourceRsc.name,
                await findReferencingSlugs(
                  sourceRsc.name,
                  rel.sourceLocalKey,
                  keys
                )
              );
            }

            if (rel.to === entry.source) {
              const targetKeys = new Set(entryValues(entry, rel.targetForeignKey));
              if (targetKeys.size) {
                // throughLocalKey has no guaranteed generated index. Scan the
                // current through records; changed/deleted through records are
                // separately covered by the through-source branch above.
                if (!throughRecordsBySource.has(rel.through)) {
                  throughRecordsBySource.set(
                    rel.through,
                    this.sourceLoader.loadBySourceName(rel.through)
                  );
                }
                const throughRecords = await throughRecordsBySource.get(rel.through)!;
                const throughKeys = uniqueValues(
                  throughRecords
                    .filter((record) =>
                      resolveField(record, rel.throughLocalKey).some((key) =>
                        targetKeys.has(key)
                      )
                    )
                    .map((record) => resolveField(record, rel.throughForeignKey))
                );
                addAffectedSlugs(
                  sourceRsc.name,
                  await findReferencingSlugs(
                    sourceRsc.name,
                    rel.sourceLocalKey,
                    throughKeys
                  )
                );
              }
            }
          } else if (rel.to === entry.source) {
            const keys = entryValues(entry, rel.foreignKey);
            addAffectedSlugs(
              sourceRsc.name,
              await findReferencingSlugs(sourceRsc.name, rel.localKey, keys)
            );
          }
        }
      }
    }

    const originalSlugsBySource = new Map<string, Set<string>>();
    for (const entry of originalEntries) {
      if (!originalSlugsBySource.has(entry.source)) {
        originalSlugsBySource.set(entry.source, new Set());
      }
      originalSlugsBySource.get(entry.source)!.add(entry.slug);
    }

    const propagatedEntries: DiffEntry[] = [];
    for (const [source, candidateSlugs] of affectedSlugs) {
      const alreadyChanged = originalSlugsBySource.get(source) ??
        new Set<string>();
      const records = await this.sourceLoader.loadBySlugs(
        source,
        [...candidateSlugs].filter((slug) => !alreadyChanged.has(slug))
      );
      const rsc = this.resolver.resolveOne(source);
      for (const record of records) {
        const fields: Record<string, unknown> = {};
        for (const field of Object.keys(rsc.indexes ?? {})) {
          const customIndexer = this.customIndexers[`${rsc.name}.${field}`];
          fields[field] = customIndexer
            ? customIndexer(record)
            : resolveField(record, field);
        }
        fields.slug = record.slug;
        propagatedEntries.push({
          status: "M",
          source,
          slug: record.slug,
          fields,
          oldFields: { ...fields },
        });
      }
    }

    diffEntries = [...originalEntries, ...propagatedEntries];
    const entryGroup: EntryGroup = new Map();
    const touched: string[] = [];

    for (const entry of diffEntries) {
      const statuses: Array<"A" | "D"> = entry.status === "M"
        ? entry.oldFields ? ["D", "A"] : ["A"]
        : [entry.status];
      if (!entryGroup.has(entry.source)) entryGroup.set(entry.source, new Map());
      const source = entryGroup.get(entry.source)!;
      for (const status of statuses) {
        if (!source.has(status)) source.set(status, new Set());
        source.get(status)!.add({ slug: entry.slug });
      }
    }

    const diffMap = new Map<string, Map<string, DiffEntry>>();
    for (const e of diffEntries) {
      if (!diffMap.has(e.source)) diffMap.set(e.source, new Map());
      diffMap.get(e.source)!.set(e.slug, e);
    }

    const changedRows = new Map<string, Set<SourceRecord>>();
    const addedRecords = new Map<string, Map<string, SourceRecord>>();
    const deletedRecords = new Map<string, Map<string, SourceRecord>>();
    const deletedRows = new Set<SourceRecord>();

    for (const [source, entries] of entryGroup.entries()) {
      const rsc = this.resolver.resolveOne(source);
      if (!rsc.indexes) continue;

      /* --- 1. Load current records and old-value delete records --- */
      const addOrMod = entries.get("A") ?? new Set();
      const delOnly = entries.get("D") ?? new Set();

      const slugsToLoad = [...addOrMod].map((p) => p.slug);

      /* --- 2. 実ファイルをロード (存在する想定だけ) -------------- */
      const loaded = await this.sourceLoader.loadBySlugs(source, slugsToLoad);

      if (!changedRows.has(rsc.name)) changedRows.set(rsc.name, new Set());
      addedRecords.set(rsc.name, new Map(loaded.map((rec) => [rec.slug, rec])));
      deletedRecords.set(rsc.name, new Map());

      /* 2-A. 取得できたレコードはそのまま */
      loaded.forEach((rec) => changedRows.get(rsc.name)!.add(rec));

      const loadedSlugs = new Set(loaded.map((r) => r.slug));

      /* 2-B. 取得できなかった slug は擬似レコード */
      for (const slug of slugsToLoad) {
        if (loadedSlugs.has(slug)) continue; // 取れている
        const diff = diffMap.get(source)!.get(slug);
        if (!diff) continue; // 保険
        changedRows.get(rsc.name)!.add(makePseudo(diff));
      }

      /* --- 3. 削除 (D) は必ず擬似レコード ----------------------- */
      for (const { slug } of delOnly) {
        const diff = diffMap.get(source)!.get(slug);
        if (!diff) continue;
        const record = makePseudo({
          ...diff,
          fields: diff.status === "M" ? diff.oldFields : diff.fields,
        });
        changedRows.get(rsc.name)!.add(record);
        deletedRecords.get(rsc.name)!.set(slug, record);
        deletedRows.add(record);
      }
    }

    function makePseudo(diff: DiffEntry): SourceRecord {
      const record = { slug: diff.slug, ...diff.fields } as SourceRecord;
      Object.defineProperty(record, PSEUDO_FIELDS, {
        value: diff.fields ?? {},
        enumerable: true,
      });
      return record;
    }

    // Preserve the existing missing-relation errors independently of the
    // complete datasets used below. Only changed sources need resolving.
    const legacy = new Map(changedRows);
    for (const [sourceName, allData] of changedRows) {
      const originalSlugs = originalSlugsBySource.get(sourceName);
      if (!originalSlugs) continue;
      const data = new Set(
        [...allData].filter((row) => originalSlugs.has(row.slug))
      );
      if (!data.size) continue;
      const rsc = this.resolver.resolveOne(sourceName);
      const relations = rsc.relations ?? [];

      for (const rel of Object.values(relations)) {
        if (isThroughRelation(rel)) {
          // is through relation

          if (!legacy.get(rel.to)) {
            let through = legacy.get(rel.through);
            if (!through) {
              const prefixIndexLine = (
                await Promise.all(
                  [...data].flatMap((s) =>
                    resolveField(s, rel.sourceLocalKey).map((value) =>
                      this.reader.findIndexLines(
                        rel.through,
                        rel.throughForeignKey,
                        value
                      )
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

              legacy.set(rel.through, through);
            }

            let to = legacy.get(rel.to);
            if (!to) {
              const prefixIndexLine = (
                await Promise.all(
                  [...through].flatMap((s) =>
                    resolveField(s, rel.throughLocalKey).map((value) =>
                      this.reader.findIndexLines(
                        rel.to,
                        rel.targetForeignKey,
                        value
                      )
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

              legacy.set(rel.to, to);
            }
          }
        } else {
          // is direct relation

          if (!legacy.get(rel.to)) {
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

            legacy.set(rel.to, to);
          }
        }
      }
    }

    // Index lookups still describe the previous state. Additions use current
    // records, while deletions must resolve the old values from diff fields.
    const collectTargets = async (
      sourceName: string,
      slugs: string[],
      view: "A" | "D"
    ): Promise<SourceRecord[]> => {
      const added = addedRecords.get(sourceName);
      const deleted = deletedRecords.get(sourceName);
      const unique = [...new Set(slugs)];
      const records = await this.sourceLoader.loadBySlugs(
        sourceName,
        unique.filter((slug) => !deleted?.has(slug) && !added?.has(slug))
      );
      const targets = new Map(records.map((record) => [record.slug, record]));
      if (view === "A") {
        for (const [slug, record] of added ?? []) targets.set(slug, record);
      } else {
        for (const slug of unique) {
          const record = deleted?.get(slug);
          if (record) targets.set(slug, record);
        }
      }
      return [...targets.values()];
    };

    const findSlugs = async (
      sourceName: string,
      field: string,
      keys: string[]
    ): Promise<string[]> => {
      const lines = await Promise.all(
        keys.map((key) => this.reader.findIndexLines(sourceName, field, key))
      );
      return [...new Set(
        lines.flatMap((result) =>
          (result ?? []).flatMap((line) => Object.keys(line.ref))
        )
      )];
    };

    const relationData: IncrementalRelationData = new Map();
    for (const [sourceName, data] of changedRows) {
      const rsc = this.resolver.resolveOne(sourceName);
      const sourceRelations = new Map<
        string,
        { A: IncrementalView; D: IncrementalView }
      >();
      relationData.set(sourceName, sourceRelations);
      for (const [key, rel] of Object.entries(rsc.relations ?? {})) {
        const buildView = async (view: "A" | "D"): Promise<IncrementalView> => {
          const rows = [...data].filter(
            (row) => deletedRows.has(row) === (view === "D")
          );
          if (isThroughRelation(rel)) {
            const throughRecords = rows.length === 0 ? [] :
              await collectTargets(
                rel.through,
                await findSlugs(
                  rel.through,
                  rel.throughForeignKey,
                  rows.flatMap((row) => resolveField(row, rel.sourceLocalKey))
                ),
                view
              );
            const toRecords = rows.length === 0 ? [] :
              await collectTargets(
                rel.to,
                await findSlugs(
                  rel.to,
                  rel.targetForeignKey,
                  throughRecords.flatMap((row) => resolveField(row, rel.throughLocalKey))
                ),
                view
              );
            return {
              throughRecords,
              toRecords,
              throughMap: buildForeignKeyMap(throughRecords, rel.throughForeignKey),
              targetMap: buildForeignKeyMap(toRecords, rel.targetForeignKey),
            };
          }
          const targets = rows.length === 0 ? [] :
            await collectTargets(
              rel.to,
              await findSlugs(
                rel.to,
                rel.foreignKey,
                rows.flatMap((row) => resolveField(row, rel.localKey))
              ),
              view
            );
          return {
            targets,
            foreignMap: buildForeignKeyMap(targets, rel.foreignKey),
          };
        };
        sourceRelations.set(key, {
          A: await buildView("A"),
          D: await buildView("D"),
        });
      }
    }

    for (const [source] of entryGroup.entries()) {
      const rsc = this.resolver.resolveOne(source);
      const relations = rsc.relations ?? [];

      if (!rsc.indexes || !relations) continue;

      const recordStatuses = new Map<SourceRecord, "A" | "D">();
      const records = [...changedRows.get(rsc.name)!].map((row) => {
        const result = { ...row };
        recordStatuses.set(result, deletedRows.has(row) ? "D" : "A");
        for (const [key, rel] of Object.entries(relations)) {
          const view = relationData.get(rsc.name)!.get(key)![
            deletedRows.has(row) ? "D" : "A"
          ];
          if (isThroughRelation(rel)) {
            const throughView = view as IncrementalThroughView;
            result[key] = resolveThroughRelation(
              row,
              rel,
              throughView.throughRecords,
              throughView.toRecords,
              throughView.targetMap,
              throughView.throughMap
            );
          } else {
            const directView = view as IncrementalDirectView;
            result[key] = resolveDirectRelation(
              row,
              rel,
              directView.targets,
              directView.foreignMap
            );
          }
        }
        return result;
      });

      for (const status of ["D", "A"] as const) {
        const statusRecords = records.filter((row) =>
          recordStatuses.get(row) === status
        );
        if (!statusRecords.length) continue;
        const prefixes = this.getPrefixIndexPathByResolvedRecords(statusRecords, rsc);
        const entries = this.createIndexLines(statusRecords, prefixes, rsc, status);

        for await (const [path, contents] of Array.from(entries)) {
          let data: Set<PrefixIndexLine> = new Set();
          if (await this.repository.exists(path)) {
            const existedRaw = await this.repository.readFile(path);
            data = new Set(existedRaw.split("\n").map((raw) => JSON.parse(raw)));
          }

          for (const [entryStatus, contentEntries] of contents) {
            for (const c of contentEntries) {
              if (entryStatus === "A") {
                const same = [...data].find((e) => e.v === c.v && e.vs === c.vs);
                if (same) {
                  same.ref = { ...same.ref, ...c.ref };
                } else {
                  data.add(c);
                }
              } else if (entryStatus === "D") {
                for (const same of [...data].filter((e) => e.v === c.v && e.vs === c.vs)) {
                  for (const slug of Object.keys(c.ref)) delete same.ref[slug];
                  if (Object.keys(same.ref).length === 0) data.delete(same);
                }
              }

              const raw = [...data]
                .sort(indexSort())
                .map((c) => JSON.stringify(c))
                .join("\n");

              if (!raw.length) {
                await this.repository.removeDir(toParent(path));
                touched.push(path);
              } else {
                await this.repository.writeFile(path, raw);
                touched.push(path);
              }
            }
          }

        }
        for (const [path, value] of this.collectPrefixDirs(prefixes, rsc)) {
          if (status === "A") {
            if (await this.repository.exists(path)) {
              const existsRaw = await this.repository.readFile(path);
              const existed = new Set(existsRaw.split("\n").map((raw) => raw));
              for (const prefixString of value) {
                existed.add(prefixString);
              }
              const raw = [...existed]
                .sort(compareOrdinal)
                .map((c) => c)
                .join("\n");

              await this.repository.writeFile(path, raw);
              touched.push(path);
            } else {
              const raw = [...value]
                .sort(compareOrdinal)
                .map((c) => c)
                .join("\n");

              await this.repository.writeFile(path, raw);
              touched.push(path);
            }
          } else {
            if (!(await this.repository.exists(path))) continue;
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
    rsc: RSC
  ): Map<string, Map<string, Set<string>>> {
    const indexes = rsc.indexes!;
    const indexFields = Array.from(new Set(Object.keys(indexes)));
    const prefixes = new Map<string, Map<string, Set<string>>>();

    for (const record of records) {
      const paths = new Map<string, Set<string>>();
      for (const field of indexFields) {
        let fieldValues = resolveIndexValues(record, field, rsc.relations);

        // For custom indexers, resolveField returns empty because the field
        // doesn't exist on the record. Use the custom indexer callback instead.
        if (fieldValues.length === 0 && this.customIndexers) {
          for (const [key, callback] of Object.entries(this.customIndexers)) {
            if (key.endsWith(`.${field}`)) {
              try {
                const customValue = callback(record);
                if (customValue != null) {
                  const arr = Array.isArray(customValue) ? customValue : [customValue];
                  fieldValues = arr.map((v) => String(v));
                }
              } catch {
                // skip
              }
              break;
            }
          }
        }

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
    statusOverride: "A" | "D" = "A"
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

            const status = statusOverride;

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
    rsc: RSC
  ): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();

    if (!rsc.indexes) throw new Error(`[${rsc.name}] has no indexes configured`);

    for (const fieldMap of data.values()) {
      for (const [fieldName, prefixes] of fieldMap.entries()) {
        const indexConfig = rsc.indexes[fieldName];
        for (const prefix of prefixes) {
          const parts = prefix.split("/");

          let path = indexConfig.dir;
          for (let i = 0; i < parts.length; i++) {
            const dir = parts[i];

            if (!result.has(path)) result.set(path, new Set());
            result.get(path)!.add(dir);

            path += dir + "/";
          }
        }
      }
    }

    // convert to prefix index file path list
    const final = new Map<string, Set<string>>();
    for (const [dir, items] of Array.from(result).reverse()) {
      final.set(toP(dir), new Set([...items].sort(compareOrdinal)));
    }

    return final;
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
      let valueArr = resolveIndexValues(record, field, rsc.relations);

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
