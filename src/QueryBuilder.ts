import { resolveField } from "./utils/field.js";
import {
  resolveDirectRelation,
  resolveThroughRelation,
} from "./utils/relationResolver.js";
import { SourceLoader } from "./SourceLoader";
import { Indexer } from "./Indexer";
import {
  DirectRelation,
  ResolvedSourceConfig as RSC,
  SourceConfigResolver as Resolver,
  SourceRecord,
  ThroughRelation,
} from "./SourceConfigResolver";
import { LoggerProvider } from "./logger/LoggerProvider";
import {
  createPageInfo,
  CursorObject,
  decodeCursor,
  encodeCursor,
  getPageSlice,
  PageInfo,
} from "./utils/pagenation.js";
import { Fields, JoinableKeys, PrefixIndexLine } from "./utils/typs.js";

type CustomIndex = { __brand: "CustomIndex" };

type OmitCustomIndex<T> = {
  [K in keyof T as T[K] extends CustomIndex ? never : K]: T[K];
};

type Operator = "eq" | "startsWith" | "in";

type Filter =
  | { field: string; op: "eq" | "startsWith"; value: string }
  | { field: string; op: "in"; value: string[] };

type OrderByDirection = "asc" | "desc";

export interface PageResult<T> {
  data: OmitCustomIndex<T>[];
  pageInfo: PageInfo;
}

/**
 * QueryBuilder allows for type-safe querying and joining of static structured data.
 */
export class QueryBuilder<T extends SourceRecord> {
  private joins: string[] = [];
  private filters: Filter[] = [];
  private _orderByKey?: Fields<T> | "slug" = "slug";
  private _orderByDirection: OrderByDirection = "asc";
  private _cursorValue?: string;
  private _cursorDirection: "after" | "before" = "after";
  private _pageSize: number = 20;

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
    op: "eq" | "startsWith",
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
   * Specifies the sorting order for the query.
   *
   * @param key - Field to order by. Default is "slug".
   * @param direction - Sort direction: "asc" or "desc". Default is "asc".
   * @returns This instance (for method chaining).
   */
  orderBy(key: Fields<T>, direction: OrderByDirection = "asc"): this {
    this._orderByKey = key;
    this._orderByDirection = direction;
    return this;
  }

  /**
   * Sets the pagination cursor for the query.
   *
   * @param cursor - The encoded cursor string (usually Base64).
   *   Use the `endCursor` from the previous page's `pageInfo` for forward pagination,
   *   or the `startCursor` for backward pagination.
   * @param direction - Pagination direction: `"after"` for next page, `"before"` for previous page.
   *   Defaults to `"after"`.
   * @returns This instance (for method chaining).
   */
  cursor(value?: string, direction: "after" | "before" = "after"): this {
    this._cursorValue = value;
    this._cursorDirection = direction;
    return this;
  }

  /**
   * Sets the number of records to return per page.
   *
   * @param n - The maximum number of records to return for this query (page size).
   *   Should be a positive integer.
   * @returns This instance (for method chaining).
   */
  pageSize(n: number): this {
    this._pageSize = n;
    return this;
  }

  /**
   * Executes the query and returns matching records.
   *
   * @returns Matched data records.
   */
  async exec(): Promise<PageResult<T>> {
    const rsc = this.resolver.resolveOne(this.sourceName);
    const filters = this.extractIndexFilters(rsc);
    const requiresJoin = this.joins.length > 0;
    const orderByKey = String(this._orderByKey);

    const empty = {
      data: [],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: undefined,
        endCursor: undefined,
      },
    };

    let matched = await this.getMatchedIndexes(this.sourceName, filters, rsc);

    let page: PrefixIndexLine[];
    let pageInfo: PageInfo;
    const encodeCursorCallback = (item: PrefixIndexLine) => {
      const refsLength = Object.keys(item.r).length;
      const slug = Object.keys(item.r)[refsLength - 1];
      const orderValue = Object.values(item.r)[refsLength - 1][orderByKey];

      return encodeCursor({ order: { [orderByKey]: orderValue[0] }, slug });
    };

    if (matched.length) {
      const cursorObj = this._cursorValue
        ? decodeCursor(this._cursorValue)
        : undefined;

      const startIndex = this.getStartIdx(matched, cursorObj);

      page = getPageSlice(
        matched,
        startIndex,
        this._pageSize,
        this._cursorDirection
      );

      pageInfo = createPageInfo(
        page,
        this._pageSize,
        startIndex,
        matched.length,
        this._cursorDirection,
        encodeCursorCallback
      );
    } else if (!matched.length && !filters.length) {
      // no conditions

      if (!rsc.indexes![orderByKey]) {
        throw new Error(`[${this.sourceName}] needs index: ${orderByKey}`);
      }

      const indexDir = rsc.indexes![orderByKey].dir;
      const isDesc = this._orderByDirection === "desc";
      const isAfter = this._cursorDirection === "after";
      let hasPreviousPage: boolean;
      let hasNextPage: boolean;

      if (isAfter) {
        page = await Array.fromAsync(
          this.indexer.readForwardPrefixIndexLines(
            indexDir,
            this._pageSize + 1,
            this._cursorValue,
            orderByKey,
            isDesc
          )
        );
      } else {
        const data = await Array.fromAsync(
          this.indexer.readBackwardPrefixIndexLines(
            indexDir,
            this._pageSize + 1,
            this._cursorValue,
            orderByKey,
            isDesc
          )
        );

        // In backward pagination, regardless of ascending or descending order,
        // the retrieved data is ordered by the scan direction, so you need to reverse the results before returning them.
        page = data.reverse();
      }

      if (!page.length) return empty;

      // set hasPreviousPage
      hasPreviousPage = isAfter
        ? !!this._cursorValue
        : page.length > this._pageSize;

      // set hasNextPage
      hasNextPage = isAfter
        ? page.length > this._pageSize
        : !!this._cursorValue;

      page = page.slice(0, this._pageSize);

      pageInfo = {
        hasPreviousPage,
        hasNextPage,
        startCursor: encodeCursorCallback(page[0]),
        endCursor: encodeCursorCallback(page[page.length - 1]),
      };
    } else {
      return empty;
    }

    const slugs = page.flatMap((x) => Object.keys(x.r));
    let data = (await this.loader.loadBySlugs(this.sourceName, slugs)) as T[];
    if (requiresJoin) data = await this.applyJoins(data, rsc);

    return { data, pageInfo };
  }

  /**
   * Get the starting position from the specified cursor.
   */
  private getStartIdx(
    matched: PrefixIndexLine[],
    cursorObj?: CursorObject
  ): number {
    if (!cursorObj) return 0;
    const orderByKey = String(this._orderByKey);

    return matched.findIndex((item) => {
      for (const [slug, values] of Object.entries(item.r)) {
        let match = slug === cursorObj.slug;

        if (orderByKey && cursorObj.order[orderByKey]) {
          const orderValue = values[orderByKey]?.[0];
          match = match && orderValue === cursorObj.order[orderByKey];
        }

        return match;
      }

      return false;
    });
  }

  /**
   * Categorizes filters into index-usable filters.
   */
  private extractIndexFilters(rsc: RSC): Filter[] {
    const indexableFields = new Set([
      "slug",
      ...Object.keys(rsc.indexes ?? {}),
    ]);

    const indexedFilters = this.filters.filter((f) =>
      indexableFields.has(f.field)
    );
    const fallbackFilters = this.filters.filter(
      (f) => !indexableFields.has(f.field)
    );

    if (fallbackFilters.length > 0) {
      throw new Error(
        `[${this.sourceName}] needs index: ${JSON.stringify(fallbackFilters)}`
      );
    }

    return indexedFilters;
  }

  /**
   * Applies configured joins (relations) to the result set.
   */
  private async applyJoins(result: T[], rsc: RSC): Promise<T[]> {
    for (const key of this.joins) {
      const rel = rsc.relations?.[key];
      if (!rel) throw new Error(`Unknown relation: ${key}`);

      if (rel.type === "hasOneThrough" || rel.type === "hasManyThrough") {
        result = await this.applyThroughRelation(result, key, rel);
      } else if (
        rel.type === "hasOne" ||
        rel.type === "hasMany" ||
        rel.type === "belongsTo" ||
        rel.type === "belongsToMany"
      ) {
        result = await this.applyDirectRelation(result, key, rel);
      }
    }

    return result;
  }

  /**
   * Direct relations: hasOne, hasMany, belongsTo, belongsToMany
   */
  private async applyDirectRelation(
    result: T[],
    key: string,
    rel: DirectRelation
  ): Promise<T[]> {
    const directRel = rel as Extract<
      typeof rel,
      { localKey: string; foreignKey: string; type?: string }
    >;

    let foreignData: any[] = [];

    if (directRel.type === "belongsTo" || directRel.type === "belongsToMany") {
      // For belongsTo and belongsToMany, use foreignKey-based filtering
      const allLocalVals = result.flatMap((row) =>
        resolveField(row, directRel.localKey)
      );

      const uniqueIndexes =
        (await this.getMatchedIndexes(
          directRel.to,
          [{ field: directRel.foreignKey, op: "in", value: allLocalVals }],
          this.resolver.resolveOne(directRel.to)
        )) ?? [];

      foreignData = await this.loader.loadBySlugs(
        directRel.to,
        uniqueIndexes.map((index) => Object.keys(index.r)).flat()
      );
    } else {
      // For hasOne and hasMany, localKey values are treated as slugs
      const allSlugs = result.flatMap((row) =>
        resolveField(row, directRel.localKey)
      );
      const uniqueSlugs = Array.from(new Set(allSlugs));
      foreignData = await this.loader.loadBySlugs(directRel.to, uniqueSlugs);
    }

    return result.map((row) => {
      if (
        directRel.type === "belongsTo" ||
        directRel.type === "belongsToMany"
      ) {
        // Inverse lookup: match localKey values to foreignKey values
        const localVals = resolveField(row, directRel.localKey);
        const related = foreignData.filter((targetRow) => {
          const foreignVals = resolveField(targetRow, directRel.foreignKey);
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

  /**
   * For "hasOneThrough" and "hasManyThrough" relations
   */
  private async applyThroughRelation(
    result: T[],
    key: string,
    rel: ThroughRelation
  ): Promise<T[]> {
    const sourceSlugs = result.flatMap((row) =>
      resolveField(row, rel.sourceLocalKey)
    );

    // If the intermediate table doesn't use "slug", index-based lookup is required
    const uniqueSourceIndexes =
      (await this.getMatchedIndexes(
        rel.through,
        [
          {
            field: rel.throughForeignKey,
            op: "in",
            value: sourceSlugs,
          },
        ],
        this.resolver.resolveOne(rel.through)
      )) ?? [];

    const throughData = await this.loader.loadBySlugs(
      rel.through,
      uniqueSourceIndexes.map((index) => Object.keys(index.r)).flat()
    );

    const targetSlugs = throughData.flatMap((t) =>
      resolveField(t, rel.throughLocalKey)
    );

    // If the target table doesn't use "slug", index-based lookup is required
    const uniqueTargetIndexes =
      (await this.getMatchedIndexes(
        rel.to,
        [{ field: rel.targetForeignKey, op: "in", value: targetSlugs }],
        this.resolver.resolveOne(rel.through)
      )) ?? [];

    const targetData = await this.loader.loadBySlugs(
      rel.to,
      uniqueTargetIndexes.map((index) => Object.keys(index.r)).flat()
    );

    return result.map((row) => {
      const relValue = resolveThroughRelation(
        row,
        rel,
        throughData,
        targetData
      );

      return {
        ...row,
        [key]: rel.type === "hasOneThrough" ? relValue ?? null : relValue ?? [],
      };
    });
  }

  /**
   * Resolves matched slugs using index data based on filters.
   */
  private async getMatchedIndexes(
    sourceName: string,
    indexedFilters: Filter[],
    rsc: RSC
  ) {
    let matched: Set<PrefixIndexLine> = new Set();
    let matchedArray: PrefixIndexLine[];

    for (const filter of indexedFilters) {
      const { field, op, value } = filter;
      let matchedIndexes: PrefixIndexLine[] = [];

      if (Object.keys(rsc.indexes ?? {}).length) {
        if (op === "eq") {
          matchedIndexes =
            (await this.indexer.findIndexLines(
              sourceName,
              field,
              String(value)
            )) ?? [];
        } else if (op === "startsWith") {
          matchedIndexes =
            (await this.indexer.findIndexLines(
              sourceName,
              field,
              String(value),
              (indexValue, argValue) => indexValue.startsWith(argValue)
            )) ?? [];
        } else if (op === "in" && Array.isArray(value)) {
          for (const keyValue of value) {
            matchedIndexes.push(
              ...((await this.indexer.findIndexLines(
                sourceName,
                field,
                String(keyValue)
              )) ?? [])
            );
          }
        }

        if (matchedIndexes) {
          for (const matchedIndex of matchedIndexes) matched.add(matchedIndex);
        }
      }
    }

    matchedArray = [...matched];

    matchedArray.sort((a, b) => {
      const [, avs] = Object.entries(a.r)[0];
      const [, bvs] = Object.entries(b.r)[0];
      const av = String(avs[String(this._orderByKey)]);
      const bv = String(bvs[String(this._orderByKey)]);
      const aEmpty = av == null || av === "";
      const bEmpty = bv == null || bv === "";
      if (aEmpty || bEmpty) {
        throw new Error("orderby need index");
      }
      return this._orderByDirection === 'desc'
        ? bv.localeCompare(av)
        : av.localeCompare(bv);
    });

    return matchedArray?.length ? matchedArray : [];
  }
}
