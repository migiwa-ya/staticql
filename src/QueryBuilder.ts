import type { DataLoader } from "./DataLoader.js";
import type { ContentDBConfig } from "./types";
import { Indexer } from "./Indexer.js";
import {
  resolveField,
  unwrapSingleArray,
  findEntriesByPartialKey,
} from "./utils.js";

type Operator = "eq" | "contains" | "in";

type Filter =
  | { field: string; op: "eq" | "contains"; value: string }
  | { field: string; op: "in"; value: string[] };

type indexMode = "preferred" | "only" | "first-no-fallback" | "none";

export class QueryBuilder {
  private sourceName: string;
  private config: ContentDBConfig;
  private loader: DataLoader;
  private joins: string[] = [];
  private filters: Filter[] = [];
  private optionsData: { indexMode?: indexMode } = {};

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

  options(opts: { indexMode?: indexMode }): this {
    this.optionsData = {
      ...this.optionsData,
      ...opts,
    };
    return this;
  }

  async exec(): Promise<any[]> {
    const sourceDef = this.config.sources[this.sourceName];
    const indexableFields = new Set(sourceDef.index ?? []);
    const indexMode: indexMode = this.optionsData?.indexMode ?? "only";

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
      const indexer = this.indexer ?? new Indexer(this.loader, this.config);
      const allIndexes = await indexer.buildAll();
      const indexRecords = allIndexes[this.sourceName];

      for (const filter of indexedFilters) {
        const { field, op, value } = filter;
        const matched = indexRecords
          .filter((r) => {
            const v = r.values?.[field];
            if (v == null) return false;
            if (op === "eq") return v === value;
            if (op === "contains") return v.includes(value);
            if (op === "in") {
              if (!Array.isArray(value)) return false;
              const vs = v.split(" ");
              return vs.some((item: string) => value.includes(item));
            }
            return false;
          })
          .map((r) => r.slug);

        matchedSlugs = matchedSlugs
          ? matchedSlugs.filter((slug) => matched.includes(slug))
          : matched;
      }

      if (!matchedSlugs || matchedSlugs.length === 0) {
        if (indexMode === "only" || indexMode === "first-no-fallback") {
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

          const foreignMap = new Map(
            foreignData.map((row) => [
              resolveField(row, directRel.foreignKey) ?? "",
              row,
            ])
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
    }

    for (const filter of fallbackFilters) {
      const { field, op, value } = filter;
      result = result.filter((row) => {
        const val = field.split(".").reduce((acc, key) => acc?.[key], row);
        if (val == null) return false;
        if (op === "eq") return String(val) === value;
        if (op === "contains") return String(val).includes(value);
        if (op === "in") {
          if (!Array.isArray(value)) return false;
          if (Array.isArray(val)) {
            return val.some((item) => value.includes(item));
          }
          return value.includes(val);
        }
        return false;
      });
    }

    return result;
  }
}
