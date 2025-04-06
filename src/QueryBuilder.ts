import type { DataLoader } from "./DataLoader";
import type { ContentDBConfig } from "./types";
import { Indexer } from "./Indexer";
import {
  resolveField,
  unwrapSingleArray,
  findEntriesByPartialKey,
} from "./utils";

type Operator = "eq" | "contains";

type Filter = { field: string; op: Operator; value: string };

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

  where(field: string, op: Operator, value: string): QueryBuilder {
    this.filters.push({ field, op, value });
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

        const foreignData = await this.loader.load(rel.to);

        const foreignMap = new Map(
          foreignData.map((row) => [resolveField(row, rel.foreignKey), row])
        );

        result = result.map((row) => ({
          ...row,
          [key]:
            resolveField(row, rel.localKey)
              ?.split(" ")
              .map((key) =>
                unwrapSingleArray(findEntriesByPartialKey(foreignMap, key))
              )
              .filter((v) => v) ?? null,
        }));
      }
    }

    for (const filter of fallbackFilters) {
      const { field, op, value } = filter;
      result = result.filter((row) => {
        const val = field.split(".").reduce((acc, key) => acc?.[key], row);
        if (val == null) return false;
        if (op === "eq") return String(val) === value;
        if (op === "contains") return String(val).includes(value);
        return false;
      });
    }

    return result;
  }
}
