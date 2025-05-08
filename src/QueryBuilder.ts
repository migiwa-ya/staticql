import { getAllFieldValues } from "./utils/field.js";
import {
  resolveDirectRelation,
  resolveThroughRelation,
} from "./utils/relationResolver.js";
import { SourceLoader } from "./SourceLoader";
import { Indexer } from "./Indexer";
import {
  ResolvedSourceConfig as RSC,
  SourceConfigResolver as Resolver,
  SourceRecord,
} from "./SourceConfigResolver";
import { LoggerProvider } from "./logger/LoggerProvider";

// Extract joinable fields (those referencing SourceRecord or SourceRecord[])
type JoinableKeys<T> = {
  [K in keyof T]: NonNullable<T[K]> extends SourceRecord | SourceRecord[]
    ? `${Extract<K, string>}`
    : never;
}[keyof T];

// Extract queryable fields (excluding relations)
type SourceFields<T> = {
  [K in keyof T]: NonNullable<T[K]> extends SourceRecord | SourceRecord[]
    ? never
    : NonNullable<T[K]> extends (infer U)[]
    ? U extends object
      ? NestedKeys<U, Extract<K, string>>
      : K
    : NonNullable<T[K]> extends object
    ? NestedKeys<NonNullable<T[K]>, Extract<K, string>>
    : K;
}[keyof T];

// Nest traversal depth limiter
type Prev = [never, 0, 1, 2, 3, 4, 5];

// Recursively extract dot-notated nested keys
type NestedKeys<T, Prefix extends string = "", Depth extends number = 3> = [
  Depth
] extends [never]
  ? never
  : T extends object
  ? {
      [K in keyof T]: NonNullable<T[K]> extends object
        ? NestedKeys<
            NonNullable<T[K]>,
            `${Prefix}${Prefix extends "" ? "" : "."}${Extract<K, string>}`,
            Prev[Depth]
          >
        : `${Prefix}${Prefix extends "" ? "" : "."}${Extract<K, string>}`;
    }[keyof T]
  : never;

// Extract fields from relational records
type RelationalFields<T> = {
  [K in keyof T]: NonNullable<T[K]> extends SourceRecord | SourceRecord[]
    ? NonNullable<T[K]> extends (infer U)[]
      ? U extends object
        ? NestedKeys<U, Extract<K, string>>
        : never
      : NonNullable<T[K]> extends object
      ? NestedKeys<NonNullable<T[K]>, Extract<K, string>>
      : never
    : K;
}[keyof T];

// All queryable fields
type Fields<T> = RelationalFields<T> | SourceFields<T>;

type Operator = "eq" | "contains" | "in";

type Filter =
  | { field: string; op: "eq" | "contains"; value: string }
  | { field: string; op: "in"; value: string[] };

/**
 * QueryBuilder allows for type-safe querying and joining of static structured data.
 */
export class QueryBuilder<T> {
  private joins: string[] = [];
  private filters: Filter[] = [];

  constructor(
    private sourceName: string,
    private loader: SourceLoader<T>,
    private indexer: Indexer,
    private resolver: Resolver,
    private logger: LoggerProvider
  ) {}

  /**
   * Adds a relation to join with.
   *
   * @param relationKey - Name of the relation as defined in the config.
   * @returns This instance (chainable).
   */
  join<K extends JoinableKeys<T>>(relationKey: K): QueryBuilder<T> {
    this.joins = [...this.joins, relationKey as string];
    return this;
  }

  /**
   * Adds a filter condition.
   *
   * @param field - Field to filter by.
   * @param op - Operator: "eq" | "contains" | "in".
   * @param value - Value or values to compare.
   * @returns This instance (chainable).
   */
  where(
    field: Fields<T>,
    op: "eq" | "contains",
    value: string
  ): QueryBuilder<T>;
  where(field: Fields<T>, op: "in", value: string[]): QueryBuilder<T>;
  where(
    field: Fields<T>,
    op: Operator,
    value: string | string[]
  ): QueryBuilder<T> {
    this.filters.push({ field, op, value } as Filter);
    return this;
  }

  /**
   * Executes the query and returns matching records.
   *
   * @returns Matched data records.
   */
  async exec(): Promise<T[]> {
    const rsc = this.resolver.resolveOne(this.sourceName);
    const { indexedFilters, fallbackFilters } = this.extractIndexFilters(rsc);

    const requiresJoin =
      fallbackFilters.some((f) => f.field.includes(".")) ||
      this.joins.length > 0;

    let matchedSlugs = await this.getMatchedSlugsFromIndexFilters(
      this.sourceName,
      indexedFilters,
      rsc
    );

    let result: T[] =
      matchedSlugs && matchedSlugs.length > 0
        ? await Promise.all(
            matchedSlugs.map((slug) =>
              this.loader.loadBySlug(this.sourceName, slug)
            )
          )
        : await this.loader.loadBySourceName(this.sourceName);

    if (requiresJoin) {
      result = await this.applyJoins(result, rsc);
    }

    result = this.applyFallbackFilters(result, fallbackFilters);
    return result;
  }

  /**
   * Categorizes filters into index-usable and fallback (in-memory) filters.
   */
  private extractIndexFilters(rsc: RSC): {
    indexedFilters: Filter[];
    fallbackFilters: Filter[];
  } {
    const fieldIndexes = Object.keys(rsc.indexes?.fields ?? {});
    const splitIndexes = Object.keys(rsc.indexes?.split ?? {});
    const indexableFields = new Set(["slug", ...fieldIndexes, ...splitIndexes]);

    const indexedFilters = this.filters.filter((f) =>
      indexableFields.has(f.field)
    );
    const fallbackFilters = this.filters.filter(
      (f) => !indexableFields.has(f.field)
    );

    if (fallbackFilters.length > 0) {
      this.logger.warn(
        "Fallback filter triggered (full scan)",
        this.sourceName,
        fallbackFilters
      );
    }

    return { indexedFilters, fallbackFilters };
  }

  /**
   * Applies configured joins (relations) to the result set.
   */
  private async applyJoins(result: T[], rsc: RSC): Promise<T[]> {
    for (const key of this.joins) {
      const rel = rsc.relations?.[key];
      if (!rel) throw new Error(`Unknown relation: ${key}`);

      // Check if the relation is a "through" relation
      const isThrough =
        rel.type === "hasOneThrough" || rel.type === "hasManyThrough";

      if (isThrough) {
        // For "hasOneThrough" and "hasManyThrough" relations

        const sourceSlugs = result.flatMap((row) =>
          getAllFieldValues(row, rel.sourceLocalKey)
        );

        // If the intermediate table doesn't use "slug", index-based lookup is required
        const uniqueSourceSlugs =
          rel.throughForeignKey !== "slug"
            ? (await this.getMatchedSlugsFromIndexFilters(
                rel.through,
                [
                  {
                    field: rel.throughForeignKey,
                    op: "in",
                    value: sourceSlugs,
                  },
                ],
                this.resolver.resolveOne(rel.through)
              )) ?? []
            : Array.from(new Set(sourceSlugs));

        const throughData = await this.loader.loadBySlugs(
          rel.through,
          uniqueSourceSlugs
        );

        const targetSlugs = throughData.flatMap((t) =>
          getAllFieldValues(t, rel.throughLocalKey)
        );

        // If the target table doesn't use "slug", index-based lookup is required
        const uniqueTargetSlugs =
          rel.targetForeignKey !== "slug"
            ? (await this.getMatchedSlugsFromIndexFilters(
                rel.to,
                [{ field: rel.targetForeignKey, op: "in", value: targetSlugs }],
                this.resolver.resolveOne(rel.through)
              )) ?? []
            : Array.from(new Set(targetSlugs));

        const targetData = await this.loader.loadBySlugs(
          rel.to,
          uniqueTargetSlugs
        );

        result = result.map((row) => {
          const relValue = resolveThroughRelation(
            row,
            rel,
            throughData,
            targetData
          );

          return {
            ...row,
            [key]:
              rel.type === "hasOneThrough" ? relValue ?? null : relValue ?? [],
          };
        });
      } else {
        // Direct relations: hasOne, hasMany, belongsTo, belongsToMany
        const directRel = rel as Extract<
          typeof rel,
          { localKey: string; foreignKey: string; type?: string }
        >;

        let foreignData: any[] = [];

        if (
          directRel.type === "belongsTo" ||
          directRel.type === "belongsToMany"
        ) {
          // For belongsTo and belongsToMany, use foreignKey-based filtering
          const allLocalVals = result.flatMap((row) =>
            getAllFieldValues(row, directRel.localKey)
          );

          const slugs = await this.getMatchedSlugsFromIndexFilters(
            directRel.to,
            [{ field: directRel.foreignKey, op: "in", value: allLocalVals }],
            this.resolver.resolveOne(directRel.to)
          );

          const uniqueSlugs = slugs ? Array.from(new Set(slugs)) : [];
          foreignData = await this.loader.loadBySlugs(
            directRel.to,
            uniqueSlugs
          );
        } else {
          // For hasOne and hasMany, localKey values are treated as slugs
          const allSlugs = result.flatMap((row) =>
            getAllFieldValues(row, directRel.localKey)
          );
          const uniqueSlugs = Array.from(new Set(allSlugs));
          foreignData = await this.loader.loadBySlugs(
            directRel.to,
            uniqueSlugs
          );
        }

        result = result.map((row) => {
          if (
            directRel.type === "belongsTo" ||
            directRel.type === "belongsToMany"
          ) {
            // Inverse lookup: match localKey values to foreignKey values
            const localVals = getAllFieldValues(row, directRel.localKey);
            const related = foreignData.filter((targetRow) => {
              const foreignVals = getAllFieldValues(
                targetRow,
                directRel.foreignKey
              );
              return localVals.some((val) => foreignVals.includes(val));
            });
            return { ...row, [key]: related };
          } else {
            const relValue = resolveDirectRelation(row, directRel, foreignData);
            return {
              ...row,
              [key]:
                directRel.type === "hasOne" ? relValue ?? null : relValue ?? [],
            };
          }
        });
      }
    }

    return result;
  }

  /**
   * Applies in-memory filters that could not be satisfied via index.
   */
  private applyFallbackFilters(result: T[], fallbackFilters: Filter[]): T[] {
    for (const filter of fallbackFilters) {
      const { field, op, value } = filter;

      result = result.filter((row) => {
        const vals = getAllFieldValues(row, field);
        if (vals.length === 0) return false;
        if (op === "eq") return vals[0] === value;
        if (op === "contains") return vals.some((v) => v.includes(value));
        if (op === "in" && Array.isArray(value))
          return vals.some((v) => value.includes(v));
        return false;
      });
    }
    return result;
  }

  /**
   * Resolves matched slugs using index data based on filters.
   */
  private async getMatchedSlugsFromIndexFilters(
    sourceName: string,
    indexedFilters: Filter[],
    rsc: RSC
  ): Promise<string[] | null> {
    let indexSlugs: string[] | null = null;

    for (const filter of indexedFilters) {
      const { field, op, value } = filter;
      let matched: string[] = [];

      if (field === "slug") {
        matched.push(String(value));
      } else if (Object.keys(rsc.indexes?.split ?? {}).length) {
        // Split-index handling

        if (op === "eq") {
          const keyValue = String(value);
          matched =
            (await this.indexer.getSplitIndex(sourceName, field, keyValue)) ??
            [];
        } else if (op === "in" && Array.isArray(value)) {
          for (const keyValue of value) {
            matched.push(
              ...((await this.indexer.getSplitIndex(
                sourceName,
                field,
                keyValue
              )) ?? [])
            );
          }
        } else if (op === "contains") {
          const indexPaths = await this.indexer.getSplitIndexPaths(
            sourceName,
            field
          );
          for (const path of indexPaths) {
            const key = path.replace(/^.*\//, "").replace(/\.json$/, "");
            if (key.includes(String(value))) {
              matched.push(
                ...((await this.indexer.getSplitIndex(
                  sourceName,
                  field,
                  key
                )) ?? [])
              );
            }
          }
        }
      } else {
        // Single-index handling
        if (op === "eq") {
          matched =
            (await this.indexer.getFieldIndex(
              sourceName,
              field,
              String(value)
            )) ?? [];
        } else if (op === "in" && Array.isArray(value)) {
          const indexMap =
            (await this.indexer.getFieldIndexes(sourceName, field)) ?? {};
          matched = value.flatMap((v) => indexMap![String(v)] ?? []);
        } else if (op === "contains") {
          const indexMap: string[] =
            (await this.indexer.getFieldIndexes(sourceName, field)) ?? {};
          matched = Object.entries(indexMap)
            .filter(([k]) => k.includes(String(value)))
            .flatMap(([, slugs]) => slugs);
        }
      }

      indexSlugs = indexSlugs
        ? indexSlugs.filter((slug) => matched.includes(slug))
        : matched;
    }

    return indexSlugs?.length ? indexSlugs : null;
  }
}
