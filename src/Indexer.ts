import { DataLoader } from "./DataLoader.js";
import { ContentDBConfig } from "./types";
import type { StorageProvider } from "./storage/StorageProvider";
import {
  resolveField,
  unwrapSingleArray,
  findEntriesByPartialKey,
  extractNestedProperty,
  buildForeignKeyMap,
  ensureDir,
} from "./utils.js";

export class Indexer {
  private loader: DataLoader;
  private config: ContentDBConfig;
  private cache: Record<string, any[]> | null = null;

  constructor(loader: DataLoader, config: ContentDBConfig) {
    this.loader = loader;
    this.config = config;
  }

  async buildAll(): Promise<Record<string, any[]>> {
    if (this.cache) return this.cache;

    const result: Record<string, any[]> = {};

    for (const [sourceName, sourceDef] of Object.entries(this.config.sources)) {
      if (!sourceDef.index) continue;
      result[sourceName] = await this.buildSourceIndex(sourceName, sourceDef);
    }

    this.cache = result;
    return result;
  }

  /**
   * 1つのsourceについてインデックス用レコード配列を生成する
   * @param sourceName 
   * @param sourceDef 
   * @returns Promise<any[]>
   */
  private async buildSourceIndex(sourceName: string, sourceDef: any): Promise<any[]> {
    let data = await this.loader.load(sourceName);

    const joins = Object.keys(sourceDef.relations ?? {});
    for (const key of joins) {
      const rel = sourceDef.relations![key];

      // Type guard for through relation
      const isThrough =
        typeof rel === "object" &&
        "through" in rel &&
        (rel.type === "hasOneThrough" || rel.type === "hasManyThrough");

      if (isThrough) {
        // Through relation (hasOneThrough, hasManyThrough)
        const throughData = await this.loader.load(rel.through);
        const targetData = await this.loader.load(rel.to);
        const targetMap = new Map(
          targetData.map((row: any) => [
            resolveField(row, rel.targetForeignKey) ?? "",
            row,
          ])
        );

        data = data.map((row: any) => {
          const sourceKey = resolveField(row, rel.sourceLocalKey);
          if (!sourceKey)
            return {
              ...row,
              [key]: rel.type === "hasManyThrough" ? [] : null,
            };

          const throughMatches = throughData.filter((t: any) =>
            (resolveField(t, rel.throughForeignKey) ?? "")
              .split(" ")
              .includes(sourceKey)
          );

          const targets = throughMatches
            .map((t: any) => {
              const throughKey = resolveField(t, rel.throughLocalKey);
              return (throughKey ?? "")
                .split(" ")
                .map((k: string) => targetMap.get(k))
                .filter((v: any) => v);
            })
            .flat();

          if (rel.type === "hasOneThrough") {
            return { ...row, [key]: targets.length > 0 ? targets[0] : null };
          } else {
            // hasManyThrough
            return { ...row, [key]: targets };
          }
        });
      } else {
        // Type guard for direct relation
        const directRel = rel as Extract<
          typeof rel,
          { localKey: string; foreignKey: string }
        >;
        const foreignData = await this.loader.load(directRel.to);

        const foreignMap = new Map(
          foreignData.map((row: any) => [
            resolveField(row, directRel.foreignKey) ?? "",
            row,
          ])
        );

        data = data.map((row: any) => {
          const relType = (directRel as any).type;
          const localVal = resolveField(row, directRel.localKey) ?? "";
          const keys = localVal.split(" ").filter(Boolean);
          const matches = keys
            .map((k: string) =>
              unwrapSingleArray(findEntriesByPartialKey(foreignMap, k))
            )
            .filter((v: any) => v);

          if (relType === "hasOne") {
            return { ...row, [key]: matches.length > 0 ? matches[0] : null };
          } else if (relType === "hasMany") {
            return { ...row, [key]: matches };
          } else {
            // Default: array for backward compatibility
            return { ...row, [key]: matches };
          }
        });
      }
    }

    const records = data.map((row: any) => {
      const values: Record<string, string> = {};

      for (const field of sourceDef.index!) {
        const val = resolveField(row, field);
        if (val != null && String(val)) {
          values[field] = String(val);
        }
      }

      return {
        slug: row.slug,
        values,
      };
    });

    return records;
  }

  async saveTo(outputDir: string): Promise<void> {
    const all = await this.buildAll();
    // Provider経由でファイル出力
    const provider: StorageProvider = (this.loader as any).provider;

    for (const [sourceName, records] of Object.entries(all)) {
      const sourceDef = this.config.sources[sourceName];

      // Write index files per field
      if (sourceDef.index) {
        for (const field of sourceDef.index) {
          if (sourceDef.splitIndexByKey) {
            // 分割方式: output/{source_name}/index-{field}/{key_value}.json
            const dirPath = `${outputDir.replace(
              /\/$/,
              ""
            )}/${sourceName}/index-${field}`;
            // ローカルファイルシステム時のみensureDir
            if (
              (provider as any).type === "filesystem" ||
              (provider as any).baseDir !== undefined
            ) {
              await ensureDir(dirPath);
            }
            // key_valueごとにファイルを分割出力
            const keyMap: Record<string, string[]> = {};
            for (const rec of records) {
              const value = rec.values[field];
              if (value == null) continue;
              for (const v of value.split(" ")) {
                if (!v) continue;
                if (!keyMap[v]) keyMap[v] = [];
                keyMap[v].push(rec.slug);
              }
            }
            for (const [keyValue, slugs] of Object.entries(keyMap)) {
              const filePath = `${dirPath}/${keyValue}.json`;
              await provider.writeFile(
                filePath,
                JSON.stringify(slugs, null, 2)
              );
            }
          } else {
            // 従来方式: {source_name}.index-{field}.json
            const indexMap: Record<string, string[]> = {};
            for (const rec of records) {
              const value = rec.values[field];
              if (value == null) continue;
              // Support multi-value fields (space-separated)
              for (const v of value.split(" ")) {
                if (!v) continue;
                if (!indexMap[v]) indexMap[v] = [];
                indexMap[v].push(rec.slug);
              }
            }
            const filePath = `${outputDir.replace(
              /\/$/,
              ""
            )}/${sourceName}.index-${field}.json`;
            await provider.writeFile(
              filePath,
              JSON.stringify(indexMap, null, 2)
            );
          }
        }
      }

      // Write a single meta file per source
      if (sourceDef.meta) {
        // Load the original data to preserve array/object structure
        const originalData = await this.loader.load(sourceName);
        const metaMap: Record<string, Record<string, any>> = {};

        // Preload all relation data for efficiency
        const relationData: Record<string, any> = {};
        if (sourceDef.relations) {
          for (const relKey of Object.keys(sourceDef.relations)) {
            const rel = sourceDef.relations[relKey];
            if (
              "through" in rel &&
              (rel.type === "hasOneThrough" || rel.type === "hasManyThrough")
            ) {
              // Through relation
              const throughData = await this.loader.load(rel.through);
              const targetData = await this.loader.load(rel.to);
              relationData[relKey] = { throughData, targetData, rel };
            } else {
              // Direct relation
              const foreignData = await this.loader.load(rel.to);
              relationData[relKey] = { foreignData, rel };
            }
          }
        }

        for (const row of originalData) {
          const metaObj = this.extractMetaForRow(row, sourceDef, relationData);
          metaMap[row.slug] = metaObj;
        }

        const filePath = `${outputDir.replace(
          /\/$/,
          ""
        )}/${sourceName}.meta.json`;
        await provider.writeFile(filePath, JSON.stringify(metaMap, null, 2));
      }
    }
  }

  /**
   * Extracts meta fields for a row, handling relations and dot notation.
   */
  private extractMetaForRow(
    row: any,
    sourceDef: any,
    relationData: Record<string, any>
  ): Record<string, any> {
    const metaObj: Record<string, any> = {};

    for (const field of sourceDef.meta) {
      const parts = field.split(".");

      if (
        parts.length > 1 &&
        sourceDef.relations &&
        sourceDef.relations[parts[0]]
      ) {
        // Relation property
        const relKey = parts[0];
        const relProp = parts.slice(1);
        const rel = sourceDef.relations[relKey];
        let relValue: any;

        if (
          "through" in rel &&
          (rel.type === "hasOneThrough" || rel.type === "hasManyThrough")
        ) {
          relValue = this.resolveThroughRelation(
            row,
            rel,
            relationData[relKey]
          );
        } else {
          relValue = this.resolveDirectRelation(row, rel, relationData[relKey]);
        }

        // Now, access the nested property using the utility
        if (Array.isArray(relValue)) {
          const values = extractNestedProperty(relValue, relProp);
          metaObj[field] = Array.from(new Set(values));
        } else if (relValue && typeof relValue === "object") {
          const arr = extractNestedProperty([relValue], relProp);
          metaObj[field] = arr.length === 1 ? arr[0] : Array.from(new Set(arr));
        } else {
          // If the relation is missing, output an empty array for hasMany, or undefined for hasOne
          const relConfig = sourceDef.relations && sourceDef.relations[relKey];
          if (
            relConfig &&
            (relConfig.type === "hasMany" ||
              relConfig.type === "hasManyThrough")
          ) {
            metaObj[field] = [];
          } else {
            metaObj[field] = undefined;
          }
        }
      } else if (sourceDef.relations && sourceDef.relations[field]) {
        // Top-level relation (no dot)
        const rel = sourceDef.relations[field];
        let relValue: any;
        if (
          "through" in rel &&
          (rel.type === "hasOneThrough" || rel.type === "hasManyThrough")
        ) {
          relValue = this.resolveThroughRelation(row, rel, relationData[field]);
        } else {
          relValue = this.resolveDirectRelation(row, rel, relationData[field]);
        }
        if (rel.type === "hasOneThrough" || rel.type === "hasOne") {
          metaObj[field] = relValue ?? null;
        } else {
          metaObj[field] = relValue ?? [];
        }
      } else if (row[field] !== undefined) {
        // Not a relation, use original value
        metaObj[field] = row[field];
      }
    }
    return metaObj;
  }

  /**
   * Resolves a direct relation for a row.
   */
  private resolveDirectRelation(row: any, rel: any, relationData: any): any {
    const directRel = rel as Extract<
      typeof rel,
      { localKey: string; foreignKey: string }
    >;
    const { foreignData } = relationData;
    const foreignMap = buildForeignKeyMap(foreignData, directRel.foreignKey);
    const relType = (directRel as any).type;
    const localVal = (resolveField(row, directRel.localKey) ?? "") as string;
    const keys = localVal.split(" ").filter(Boolean);

    // For each key, get all matching arrays of objects, flatten, and deduplicate
    const matches = keys
      .map((k: string) => findEntriesByPartialKey(foreignMap, k))
      .flat()
      .filter((v: any) => v);

    if (relType === "hasOne") {
      // If the first match is an array, return the array; else, return first match or null
      if (matches.length > 0 && Array.isArray(matches[0])) {
        return matches[0];
      }
      return matches.length > 0 ? matches[0] : null;
    } else if (relType === "hasMany") {
      return matches;
    } else {
      return matches;
    }
  }

  /**
   * Resolves a through relation for a row.
   */
  private resolveThroughRelation(row: any, rel: any, relationData: any): any {
    const { throughData, targetData } = relationData;
    const sourceKey = (resolveField(row, rel.sourceLocalKey) ?? "") as string;
    const throughMatches = throughData.filter((t: any) =>
      ((resolveField(t, rel.throughForeignKey) ?? "") as string)
        .split(" ")
        .includes(sourceKey)
    );
    const targetMap = new Map<string, any>(
      targetData.map((r: any) => [
        resolveField(r, rel.targetForeignKey) ?? "",
        r,
      ])
    );
    const targets = throughMatches
      .map((t: any) => {
        const throughKey = (resolveField(t, rel.throughLocalKey) ??
          "") as string;
        return throughKey
          .split(" ")
          .map((k: string) => targetMap.get(k))
          .filter((v: any) => v);
      })
      .flat();
    if (rel.type === "hasOneThrough") {
      // If the first target is an array, return the array; else, return first target or null
      if (targets.length > 0 && Array.isArray(targets[0])) {
        return targets[0];
      }
      return targets.length > 0 ? targets[0] : null;
    } else {
      return targets;
    }
  }
}
