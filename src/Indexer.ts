import { resolveField } from "./utils/field.js";
import {
  resolveDirectRelation,
  resolveThroughRelation,
  buildForeignKeyMap,
} from "./utils/relationResolver.js";
import {
  Relation,
  SourceConfigResolver as Resolver,
  SourceRecord,
  ThroughRelation,
} from "./SourceConfigResolver.js";
import { StorageRepository } from "./repository/StorageRepository.js";
import { SourceLoader } from "./SourceLoader";
import { LoggerProvider } from "./logger/LoggerProvider";

/**
 * Represents a file diff entry (for incremental index updates).
 */
export type DiffEntry = {
  status: "A" | "M" | "D" | "R";
  path: string;
  oldPath?: string;
};

/**
 * Indexer: core class for building and updating search indexes.
 */
export class Indexer {
  public static indexPrefix = "index";

  constructor(
    private readonly sourceLoader: SourceLoader<SourceRecord>,
    private readonly repository: StorageRepository,
    private readonly resolver: Resolver,
    private readonly logger: LoggerProvider
  ) {}

  /**
   * Saves indexes and slug lists for all sources.
   *
   * @throws Error if writing to storage fails.
   */
  async save(): Promise<void> {
    for await (const { sourceName, records, indexFields } of this.build()) {
      const rsc = this.resolver.resolveOne(sourceName);
      const indexes = rsc.indexes ?? {};

      for (const field of indexFields) {
        const splitPrefix = indexes.split?.[field];
        const fieldPath = indexes.fields?.[field];

        const keyMap: Record<string, string[]> = {};

        for (const rec of records) {
          const value = rec.values[field];
          if (value == null) continue;

          for (const v of value.split(" ")) {
            if (!v) continue;
            (keyMap[v] ??= []).push(rec.slug);
          }
        }

        if (splitPrefix) {
          // save splited index list
          await this.repository.writeFile(
            `${splitPrefix}_meta.json`,
            JSON.stringify(Object.keys(keyMap))
          );

          for (const [key, slugs] of Object.entries(keyMap)) {
            const filePath = `${splitPrefix}${key}.json`;
            await this.repository.writeFile(filePath, JSON.stringify(slugs));
          }
        } else if (fieldPath) {
          await this.repository.writeFile(fieldPath, JSON.stringify(keyMap));
        }
      }

      if (indexes.all) {
        await this.repository.writeFile(
          indexes.all,
          JSON.stringify(records.map((r) => r.slug))
        );
      }
    }
  }

  /**
   * Incrementally updates affected indexes based on diff entries.
   *
   * @param diffEntries - List of file change entries.
   */
  async updateIndexesForFiles(diffEntries: DiffEntry[]): Promise<void> {
    const sourceMap: Record<string, DiffEntry[]> = {};

    // Group diff entries by source
    for (const entry of diffEntries) {
      const path = entry.path;
      for (const rsc of this.resolver.resolveAll()) {
        const baseDir = rsc.pattern?.replace(/\*.*$/, "") ?? "";
        const ext = rsc.pattern?.split(".").pop();
        if (path.startsWith(baseDir) && (!ext || path.endsWith("." + ext))) {
          (sourceMap[rsc.name] ??= []).push(entry);
          break;
        }
      }
    }

    // Process each affected source
    for (const [sourceName, entries] of Object.entries(sourceMap)) {
      const rsc = this.resolver.resolveOne(sourceName);
      const slugsToAdd: string[] = [];
      const slugsToDel: string[] = [];
      const slugRenames: { oldSlug: string; newSlug: string }[] = [];

      for (const entry of entries) {
        if (entry.status === "A" || entry.status === "M") {
          slugsToAdd.push(Resolver.getSlugFromPath(rsc.pattern!, entry.path));
        } else if (entry.status === "D") {
          slugsToDel.push(Resolver.getSlugFromPath(rsc.pattern!, entry.path));
        } else if (entry.status === "R") {
          slugRenames.push({
            oldSlug: Resolver.getSlugFromPath(
              rsc.pattern!,
              entry.oldPath || ""
            ),
            newSlug: Resolver.getSlugFromPath(rsc.pattern!, entry.path),
          });
        }
      }

      const indexFields = Object.keys({
        ...(rsc.indexes?.fields ?? {}),
        ...(rsc.indexes?.split ?? {}),
      });

      /* ---------- Upsert Records ---------- */
      const slugsToUpsert = [
        ...slugsToAdd,
        ...slugRenames.map((r) => r.newSlug),
      ];

      const records = slugsToUpsert.length
        ? await this.sourceLoader.loadBySlugs(sourceName, slugsToUpsert)
        : [];

      for (const field of indexFields) {
        const splitPrefix = rsc.indexes?.split?.[field];
        const fieldPath = rsc.indexes?.fields?.[field];

        if (splitPrefix) {
          // Save as split index files
          const keyMap: Record<string, Set<string>> = {};

          for (const rec of records) {
            const value = resolveField(rec, field);
            if (value == null) continue;
            for (const v of String(value).split(" ")) {
              if (!v) continue;
              (keyMap[v] ??= new Set()).add(rec.slug);
            }
          }

          // save splited index list
          await this.repository.writeFile(
            `${splitPrefix}_meta.json`,
            JSON.stringify(Object.keys(keyMap))
          );

          for (const [keyValue, slugSet] of Object.entries(keyMap)) {
            const path = `${splitPrefix}${keyValue}.json`;
            await this.repository.writeFile(path, JSON.stringify([...slugSet]));
          }
        } else if (fieldPath) {
          // Save as single index file
          let indexMap: Record<string, string[]> = {};
          indexMap = JSON.parse(await this.repository.readFile(fieldPath));

          for (const rec of records) {
            const value = resolveField(rec, field);
            if (value == null) continue;
            for (const v of String(value).split(" ")) {
              if (!v) continue;
              indexMap[v] ??= [];
              if (!indexMap[v].includes(rec.slug)) indexMap[v].push(rec.slug);
            }
          }

          await this.repository.writeFile(fieldPath, JSON.stringify(indexMap));
        }
      }

      /* ---------- Remove Records ---------- */
      const slugsToRemove = [
        ...slugsToDel,
        ...slugRenames.map((r) => r.oldSlug),
      ];

      for (const field of indexFields) {
        const splitPrefix = rsc.indexes?.split?.[field];
        const fieldPath = rsc.indexes?.fields?.[field];

        if (splitPrefix) {
          // Update split index files
          const indexDir = Indexer.getSplitIndexDir(sourceName, field);
          const files: string[] = await (this.repository as any).listFiles(
            indexDir
          );
          const remainingKeys = new Set<string>();

          for (const file of files) {
            if (file.endsWith("meta.json")) continue;

            const slugs: string[] = JSON.parse(
              await this.repository.readFile(file)
            );
            const filtered = slugs.filter((s) => !slugsToRemove.includes(s));

            const key = file.replace(/^.*\//, "").replace(/\.json$/, "");

            if (filtered.length === 0) {
              await this.repository.removeFile(file);
            } else {
              await this.repository.writeFile(file, JSON.stringify(filtered));
              remainingKeys.add(key);
            }
          }

          // Update meta.json
          const metaPath = indexDir + "meta.json";
          await this.repository.writeFile(
            metaPath,
            JSON.stringify([...remainingKeys])
          );
        } else if (fieldPath) {
          // Update single index file
          let indexMap: Record<string, string[]> = {};
          indexMap = JSON.parse(await this.repository.readFile(fieldPath));

          for (const v of Object.keys(indexMap)) {
            indexMap[v] = indexMap[v].filter((s) => !slugsToRemove.includes(s));
            if (indexMap[v].length === 0) delete indexMap[v];
          }

          await this.repository.writeFile(fieldPath, JSON.stringify(indexMap));
        }
      }

      // Update slug index
      const slugPath = rsc.indexes?.all;
      if (slugPath) {
        let slugList: string[] = JSON.parse(
          await this.repository.readFile(slugPath)
        );
        const newSlugs = [...slugsToAdd, ...slugRenames.map((r) => r.newSlug)];
        slugList = slugList.filter((s) => !slugsToRemove.includes(s));

        for (const s of newSlugs) {
          if (!slugList.includes(s)) slugList.push(s);
        }

        await this.repository.writeFile(slugPath, JSON.stringify(slugList));
      }
    }
  }

  /** Lists file paths for a split field. */
  async getSplitIndexPaths(sourceName: string, field: string) {
    const dir = Indexer.getSplitIndexDir(sourceName, field);

    // get splited index file list (_meta.json)
    const metaPath = `${dir}_meta.json`;
    if (await this.repository.exists(metaPath)) {
      const keys: string[] = JSON.parse(
        await this.repository.readFile(metaPath)
      );
      return keys.map((key) => `${dir}${key}.json`);
    }

    return await this.repository.listFiles(dir);
  }

  /** Retrieves slug list from a split index file (if exists). */
  async getSplitIndex(sourceName: string, field: string, key: string) {
    const path = Indexer.getSplitIndexFilePath(sourceName, field, key);
    try {
      const raw = await this.repository.readFile(path);
      return JSON.parse(raw);
    } catch {
      this.logger.debug("Index file not found", { sourceName, path });
      return null;
    }
  }

  /** Loads entire field index map (non-split). */
  async getFieldIndexes(sourceName: string, field: string) {
    const path = Indexer.getFieldIndexFilePath(sourceName, field);
    try {
      const raw = await this.repository.readFile(path);
      return JSON.parse(raw);
    } catch {
      this.logger.debug("Index file not found", { sourceName, field });
      return null;
    }
  }

  /** Loads a single key's slugs from a field index map. */
  async getFieldIndex(sourceName: string, field: string, key: string) {
    const index = await this.getFieldIndexes(sourceName, field);
    return index?.[key] ?? null;
  }

  /** Loads slug index (slug list) for the source. */
  async getSlugIndexes(sourceName: string) {
    const path = Indexer.getSlugIndexFilePath(sourceName);
    try {
      return JSON.parse(await this.repository.readFile(path));
    } catch {
      this.logger.info("Slug index file not found", { sourceName });
      return null;
    }
  }

  /**
   * Builds index records for all sources.
   */
  private async *build(): AsyncGenerator<{
    sourceName: string;
    records: any[];
    indexFields: string[];
  }> {
    const configs = this.resolver.resolveAll();

    for (const { name } of configs) {
      const { records, indexFields } = await this.buildIndexRecords(name);
      yield { sourceName: name, records, indexFields };
    }
  }

  /**
   * Builds indexable records for a single source (with joined relations).
   */
  private async buildIndexRecords(
    sourceName: string
  ): Promise<{ records: any[]; indexFields: string[] }> {
    const rsc = this.resolver.resolveOne(sourceName);
    const relations = rsc.relations ?? {};

    const loadKeys = new Set<string>([sourceName]);
    for (const rel of Object.values(relations)) {
      if (this.isThroughRelation(rel)) {
        loadKeys.add(rel.through);
        loadKeys.add(rel.to);
      } else {
        loadKeys.add(rel.to);
      }
    }

    const loadedArrays = await Promise.all(
      Array.from(loadKeys).map((key) => this.sourceLoader.loadBySourceName(key))
    );
    const dataMap = Array.from(loadKeys).reduce<Record<string, any[]>>(
      (acc, key, i) => ((acc[key] = loadedArrays[i]), acc),
      {}
    );

    // Create pre-cache for relation map
    const relationMaps: Record<string, any> = {};
    for (const [key, rel] of Object.entries(relations)) {
      if (this.isThroughRelation(rel)) {
        relationMaps[key] = {
          targetMap: new Map(
            dataMap[rel.to].map((r: any) => [
              resolveField(r, rel.targetForeignKey) ?? "",
              r,
            ])
          ),
        };
      } else {
        relationMaps[key] = {
          foreignMap: buildForeignKeyMap(dataMap[rel.to], rel.foreignKey),
        };
      }
    }

    const attached = dataMap[sourceName].map((row) => {
      const result = { ...row };
      for (const [key, rel] of Object.entries(relations)) {
        result[key] = this.isThroughRelation(rel)
          ? (result[key] = resolveThroughRelation(
              row,
              rel,
              dataMap[rel.through],
              dataMap[rel.to],
              relationMaps[key].targetMap
            ))
          : (result[key] = resolveDirectRelation(
              row,
              rel,
              dataMap[rel.to],
              relationMaps[key].foreignMap
            ));
      }
      return result;
    });

    const indexFields = Array.from(
      new Set([
        ...Object.keys(rsc.indexes?.fields ?? {}),
        ...Object.keys(rsc.indexes?.split ?? {}),
      ])
    );

    const records = attached.map((row) => {
      const values: Record<string, string> = {};
      for (const field of indexFields) {
        const value = resolveField(row, field);
        if (value != null && String(value) !== "") {
          values[field] = String(value);
        }
      }
      return { slug: row.slug, values };
    });

    return { records, indexFields };
  }

  /** Determines whether the relation is a through-type. */
  private isThroughRelation(rel: Relation): rel is ThroughRelation {
    return (
      typeof rel === "object" &&
      "through" in rel &&
      (rel.type === "hasOneThrough" || rel.type === "hasManyThrough")
    );
  }

  /** Returns full path to a split index file. */
  static getSplitIndexFilePath(
    sourceName: string,
    field: string,
    keyValue: string
  ): string {
    return `${this.getSplitIndexDir(sourceName, field)}${keyValue}.json`;
  }

  /** Returns the directory path for a split index. */
  static getSplitIndexDir(sourceName: string, field: string): string {
    return `${this.indexPrefix}/${sourceName}/index-${field}/`;
  }

  /** Returns the path for a single field index file. */
  static getFieldIndexFilePath(sourceName: string, field: string): string {
    return `${this.indexPrefix}/${sourceName}.index-${field}.json`;
  }

  /** Returns the path to the slug index file. */
  static getSlugIndexFilePath(sourceName: string): string {
    return `${this.indexPrefix}/${sourceName}.index.json`;
  }
}
