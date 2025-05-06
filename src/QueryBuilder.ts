import { getAllFieldValues } from "./utils/field.js";
import {
  resolveDirectRelation,
  resolveThroughRelation,
} from "./utils/relationResolver.js";
import { SourceLoader } from "./SourceLoader";
import { Indexer } from "./Indexer";
import {
  ResolvedSourceConfig as rsc,
  SourceConfigResolver as resolver,
} from "./SourceConfigResolver";
import { LoggerProvider } from "./logger/LoggerProvider";

type Operator = "eq" | "contains" | "in";

type Filter =
  | { field: string; op: "eq" | "contains"; value: string }
  | { field: string; op: "in"; value: string[] };

export class QueryBuilder<T> {
  private joins: string[] = [];
  private filters: Filter[] = [];

  constructor(
    private sourceName: string,
    private loader: SourceLoader<T>,
    private indexer: Indexer,
    private resolver: resolver,
    private logger: LoggerProvider
  ) {}

  /**
   * リレーション（join）を追加する
   * @param relationKey - 設定で定義されたリレーション名
   * @returns this（メソッドチェーン可）
   */
  join(relationKey: string): QueryBuilder<T> {
    this.joins = [...this.joins, relationKey];

    return this;
  }

  /**
   * フィールド・演算子・値でフィルタ条件を追加する
   * @param field - フィルタ対象フィールド名
   * @param op - 演算子（"eq"|"contains"|"in"）
   * @param value - 比較値
   * @returns this（メソッドチェーン可）
   */
  where(field: string, op: "eq" | "contains", value: string): QueryBuilder<T>;
  where(field: string, op: "in", value: string[]): QueryBuilder<T>;
  where(
    field: string,
    op: Operator,
    value: string | string[]
  ): QueryBuilder<T> {
    this.filters.push({ field, op, value } as Filter);

    return this;
  }

  /**
   * クエリを実行し、条件に合致したデータ配列を返す
   * @returns クエリ結果のデータ配列
   * @throws 設定・データ不整合時に例外
   */
  async exec(): Promise<T[]> {
    const rsc = this.resolver.resolveOne(this.sourceName);

    // インデックスフィルタとフォールバックフィルタを抽出
    const { indexedFilters, fallbackFilters } = this.extractIndexFilters(rsc);

    const requiresJoin =
      fallbackFilters.some((f) => f.field.includes(".")) ||
      this.joins.length > 0;

    let result: T[] = [];
    let matchedSlugs: string[] | null = null;

    matchedSlugs = await this.getMatchedSlugsFromIndexFilters(
      this.sourceName,
      indexedFilters,
      rsc
    );

    if (matchedSlugs && matchedSlugs.length > 0) {
      result = await Promise.all(
        matchedSlugs.map((slug) =>
          this.loader.loadBySlug(this.sourceName, slug)
        )
      );
    } else if (![...indexedFilters, ...fallbackFilters].length) {
      // 検索条件なし
      result = await this.loader.loadBySourceName(this.sourceName);
    }

    // join（リレーション）処理
    if (requiresJoin) {
      result = await this.applyJoins(result, rsc);
    }

    // フィルタ適用（fallbackFilters）
    result = this.applyFallbackFilters(result, fallbackFilters);

    return result;
  }

  /**
   * インデックスフィルタとフォールバックフィルタを抽出する
   * @param rsc
   * @returns { indexedFilters: Filter[], fallbackFilters: Filter[] }
   */
  private extractIndexFilters(rsc: rsc): {
    indexedFilters: Filter[];
    fallbackFilters: Filter[];
  } {
    const fieldIndexes = Object.keys(rsc.indexes?.fields ?? {});
    const splitIndexes = Object.keys(rsc.indexes?.split ?? {});
    const indexableFields = new Set(["slug", ...fieldIndexes, ...splitIndexes]);
    let indexedFilters: Filter[] = [];
    let fallbackFilters: Filter[] = [];

    indexedFilters = this.filters.filter((f) => indexableFields.has(f.field));
    fallbackFilters = this.filters.filter((f) => !indexableFields.has(f.field));

    if (fallbackFilters.length > 0) {
      this.logger.warn(
        "インデックス未使用（全スキャン）",
        this.sourceName,
        fallbackFilters
      );
    }

    return { indexedFilters, fallbackFilters };
  }

  /**
   * join（リレーション）処理を適用する
   * @param result
   * @param sourceConfig
   * @returns Promise<T[]>
   */
  private async applyJoins(result: T[], rsc: rsc): Promise<T[]> {
    for (const key of this.joins) {
      const rel = rsc.relations?.[key];
      if (!rel) throw new Error(`Unknown relation: ${key}`);

      // Type guard for through relation
      const isThrough =
        rel.type === "hasOneThrough" || rel.type === "hasManyThrough";

      if (isThrough) {
        // Through relation (hasOneThrough, hasManyThrough)

        const sourceSlugs = result.flatMap((row) =>
          getAllFieldValues(row, rel.sourceLocalKey)
        );

        // 中間テーブルが slug でない ≒ loadBySlugs が効かない
        // その場合インデックスファイルから slug を取得する
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

        // 対象テーブルが slug でない ≒ loadBySlugs が効かない
        // その場合インデックスファイルから slug を取得する
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

          if (rel.type === "hasOneThrough") {
            return { ...row, [key]: relValue ?? null };
          } else {
            // hasManyThrough
            return { ...row, [key]: relValue ?? [] };
          }
        });
      } else {
        // Type guard for direct relation (hasOne, hasMany, belongsTo)
        const directRel = rel as Extract<
          typeof rel,
          { localKey: string; foreignKey: string; type?: string }
        >;

        let foreignData: any[] = [];
        if (
          directRel.type === "belongsTo" ||
          directRel.type === "belongsToMany"
        ) {
          // belongsTo/belongsToMany: getMatchedSlugsFromIndexFiltersでslugリストを取得
          const allLocalVals = result.flatMap((row) =>
            getAllFieldValues(row, directRel.localKey)
          );
          const slugs = await this.getMatchedSlugsFromIndexFilters(
            directRel.to,
            [{ field: directRel.foreignKey, op: "in", value: allLocalVals }],
            // directRel.localKey
            this.resolver.resolveOne(directRel.to)
          );
          const uniqueSlugs = slugs ? Array.from(new Set(slugs)) : [];
          foreignData = await this.loader.loadBySlugs(
            directRel.to,
            uniqueSlugs
          );
        } else {
          // hasOne/hasMany: localKey値をslugとしてloadBySlugs
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
            // belongsTo/belongsToMany: localKey値がforeignKey値に含まれるものを逆参照
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
            // hasOne/hasMany
            const relValue = resolveDirectRelation(row, directRel, foreignData);
            const relType = directRel.type;

            if (relType === "hasOne") {
              return { ...row, [key]: relValue ?? null };
            } else if (relType === "hasMany") {
              return { ...row, [key]: relValue ?? [] };
            } else {
              return { ...row, [key]: relValue ?? [] };
            }
          }
        });
      }
    }

    return result;
  }

  /**
   * フィルタ適用（fallbackFilters）を行う
   * @param result
   * @param fallbackFilters
   * @returns T[]
   */
  private applyFallbackFilters(result: T[], fallbackFilters: Filter[]): T[] {
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

  /**
   * インデックスフィルタから一致するslugリストを抽出する
   * @param indexedFilters
   * @param rsc
   * @returns string[] | null
   */
  private async getMatchedSlugsFromIndexFilters(
    sourceName: string,
    indexedFilters: Filter[],
    rsc: rsc
  ): Promise<string[] | null> {
    let indexSlugs: string[] | null = null;

    for (const filter of indexedFilters) {
      const { field, op, value } = filter;
      let matched: string[] = [];

      if (field === "slug") {
        // slug 検索の場合はそのまま返す

        matched.push(String(value));
      } else if (Object.keys(rsc.indexes?.split ?? {}).length) {
        // 分割インデックスファイル方式

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
        // 単一インデックスファイル方式

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
          const indexMap =
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

    if (!indexSlugs || indexSlugs.length === 0) {
      return null;
    }

    return indexSlugs;
  }
}
