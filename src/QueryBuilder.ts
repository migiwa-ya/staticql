import type { DataLoader } from "./DataLoader.js";
import type { ContentDBConfig } from "./types";
import { Indexer } from "./Indexer.js";
import type { StorageProvider } from "./storage/StorageProvider";
import {
  resolveField,
  unwrapSingleArray,
  findEntriesByPartialKey,
  buildForeignKeyMap,
  getAllFieldValues,
} from "./utils.js";

type Operator = "eq" | "contains" | "in";

type Filter =
  | { field: string; op: "eq" | "contains"; value: string }
  | { field: string; op: "in"; value: string[] };

type indexMode = "only" | "none";

export class QueryBuilder {
  private sourceName: string;
  private config: ContentDBConfig;
  private loader: DataLoader;
  private joins: string[] = [];
  private filters: Filter[] = [];
  private optionsData: { indexMode?: indexMode; indexDir?: string } = {};

  constructor(
    sourceName: string,
    config: ContentDBConfig,
    loader: DataLoader,
    joins: string[] = [],
    private indexer?: Indexer
  ) {
    this.sourceName = sourceName;
    this.config = config;
    this.loader = loader;
    this.joins = joins;
  }

  join(relationKey: string): QueryBuilder {
    this.joins = [...this.joins, relationKey];
    return this;
  }

  where(field: string, op: "eq" | "contains", value: string): QueryBuilder;
  where(field: string, op: "in", value: string[]): QueryBuilder;
  where(field: string, op: Operator, value: string | string[]): QueryBuilder {
    this.filters.push({ field, op, value } as Filter);
    return this;
  }

  options(opts: { indexMode: "only"; indexDir: string }): this;
  options(opts: { indexMode: "none" }): this;
  options(opts: { indexMode?: indexMode; indexDir?: string }): this {
    this.optionsData = {
      ...this.optionsData,
      ...opts,
    };
    return this;
  }

  async exec(): Promise<any[]> {
    const sourceDef = this.config.sources[this.sourceName];
    const indexableFields = new Set(sourceDef.index ?? []);
    const indexMode: indexMode = this.optionsData?.indexMode ?? "none";

    let indexedFilters: Filter[] = [];
    let fallbackFilters: Filter[] = [];

    if (indexMode === "none") {
      fallbackFilters = this.filters;
    } else {
      indexedFilters = this.filters.filter((f) => indexableFields.has(f.field));
      fallbackFilters = this.filters.filter(
        (f) => !indexableFields.has(f.field)
      );
    }

    const requiresJoin =
      fallbackFilters.some((f) => f.field.includes(".")) ||
      this.joins.length > 0;

    let result: any[] = [];
    let matchedSlugs: string[] | null = null;

    if (indexedFilters.length > 0 && indexMode !== "none" && sourceDef.index) {
      const indexDir = this.optionsData.indexDir || "output";
      let indexSlugs: string[] | null = null;

      for (const filter of indexedFilters) {
        const { field, op, value } = filter;
        const provider: StorageProvider = (this.loader as any).provider;
        let matched: string[] = [];

        if (sourceDef.splitIndexByKey) {
          // 分割インデックス方式
          const dirPath = `${indexDir}/${this.sourceName}/index-${field}`;
          if (op === "eq") {
            const keyValue = String(value);
            const filePath = `${dirPath}/${keyValue}.json`;
            try {
              let raw = await provider.readFile(filePath);
              let fileContent: string;
              if (raw instanceof Uint8Array) {
                fileContent = new TextDecoder().decode(raw);
              } else {
                fileContent = raw;
              }
              matched = JSON.parse(fileContent);
            } catch {
              matched = [];
            }
          } else if (op === "in" && Array.isArray(value)) {
            for (const keyValue of value) {
              const filePath = `${indexDir}/${dirPath}/${keyValue}.json`;
              try {
                let raw = await provider.readFile(filePath);
                let fileContent: string;
                if (raw instanceof Uint8Array) {
                  fileContent = new TextDecoder().decode(raw);
                } else {
                  fileContent = raw;
                }
                matched.push(...JSON.parse(fileContent));
              } catch {
                // skip missing
              }
            }
          } else if (op === "contains") {
            // containsの場合は全ファイルをリストアップして部分一致検索
            let files: string[] = [];
            try {
              files = await provider.listFiles(
                `${indexDir}/${this.sourceName}/index-${field}/`
              );
            } catch {
              files = [];
            }
            for (const file of files) {
              const key = file.replace(/^.*\//, "").replace(/\.json$/, "");
              if (key.includes(String(value))) {
                try {
                  let raw = await provider.readFile(file);
                  let fileContent: string;
                  if (raw instanceof Uint8Array) {
                    fileContent = new TextDecoder().decode(raw);
                  } else {
                    fileContent = raw;
                  }
                  matched.push(...JSON.parse(fileContent));
                } catch {
                  // skip missing
                }
              }
            }
          }
        } else {
          // 従来方式
          let indexMap: Record<string, string[]> | null = null;
          const filePath = `${indexDir}/${this.sourceName}.index-${field}.json`;
          try {
            let raw = await provider.readFile(filePath);
            let fileContent: string;
            if (raw instanceof Uint8Array) {
              fileContent = new TextDecoder().decode(raw);
            } else {
              fileContent = raw;
            }
            indexMap = JSON.parse(fileContent);
          } catch {
            indexMap = null;
          }

          if (indexMap) {
            if (op === "eq") {
              const countMap: any = {};
              for (const items of Object.values(indexMap)) {
                for (const id of items) {
                  countMap[id] = (countMap[id] || 0) + 1;
                }
              }
              matched = indexMap[String(value)].filter(
                (id) => countMap[id] === 1
              );
            } else if (op === "contains") {
              matched = Object.entries(indexMap)
                .filter(([k]) => k.includes(String(value)))
                .flatMap(([, slugs]) => slugs);
            } else if (op === "in" && Array.isArray(value)) {
              matched = value.flatMap((v) => indexMap![String(v)] ?? []);
            }
          }
        }

        indexSlugs = indexSlugs
          ? indexSlugs.filter((slug) => matched.includes(slug))
          : matched;
      }

      matchedSlugs = indexSlugs;

      if (!matchedSlugs || matchedSlugs.length === 0) {
        if (indexMode === "only") {
          return [];
        }
        matchedSlugs = null;
      }
    }

    if (matchedSlugs) {
      result = await Promise.all(
        matchedSlugs.map((slug) =>
          this.loader.loadBySlug(this.sourceName, slug)
        )
      );
    } else {
      result = await this.loader.load(this.sourceName);
    }

    if (requiresJoin) {
      for (const key of this.joins) {
        const rel = sourceDef.relations?.[key];
        if (!rel) throw new Error(`Unknown relation: ${key}`);

        // Type guard for through relation
        const isThrough =
          typeof rel === "object" &&
          "through" in rel &&
          (rel.type === "hasOneThrough" || rel.type === "hasManyThrough");

        if (isThrough) {
          // Through relation (hasOneThrough, hasManyThrough)
          const throughData = await this.loader.load(rel.through);
          const throughMap = new Map(
            throughData.map((row) => [
              resolveField(row, rel.throughForeignKey) ?? "",
              row,
            ])
          );

          const targetData = await this.loader.load(rel.to);
          const targetMap = new Map(
            targetData.map((row) => [
              resolveField(row, rel.targetForeignKey) ?? "",
              row,
            ])
          );

          result = result.map((row) => {
            const sourceKey = resolveField(row, rel.sourceLocalKey);
            if (!sourceKey)
              return {
                ...row,
                [key]: rel.type === "hasManyThrough" ? [] : null,
              };

            const throughMatches = throughData.filter((t) =>
              (resolveField(t, rel.throughForeignKey) ?? "")
                .split(" ")
                .includes(sourceKey)
            );

            const targets = throughMatches
              .map((t) => {
                const throughKey = resolveField(t, rel.throughLocalKey);
                return (throughKey ?? "")
                  .split(" ")
                  .map((k) => targetMap.get(k))
                  .filter((v) => v);
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

          // Use utility to build a Map from all possible foreignKey values to their parent object
          const foreignMap = buildForeignKeyMap(
            foreignData,
            directRel.foreignKey
          );

          result = result.map((row) => {
            const relType = (directRel as any).type;
            const localVal = resolveField(row, directRel.localKey) ?? "";
            const keys = localVal.split(" ").filter(Boolean);
            const matches = keys
              .map((k) =>
                unwrapSingleArray(findEntriesByPartialKey(foreignMap, k))
              )
              .filter((v) => v);

            if (relType === "hasOne" || relType === "belongsTo") {
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
    }

    for (const filter of fallbackFilters) {
      const { field, op, value } = filter;
      result = result.filter((row) => {
        const vals = getAllFieldValues(row, field);
        if (vals.length === 0) return false;
        if (op === "eq") return vals[0] === value;
        if (op === "contains")
          return vals.some((v: string) => v.includes(value));
        if (op === "in") {
          if (!Array.isArray(value)) return false;
          return vals.some((v: string) => value.includes(v));
        }
        return false;
      });
    }

    return result;
  }
}
