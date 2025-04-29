import { DataLoader } from "./DataLoader.js";
import {
  StaticQLConfig,
  SourceRecord,
  SourceConfig,
  RelationConfig,
  ThroughRelation,
} from "./types";
import type { StorageProvider } from "./storage/StorageProvider";
import {
  resolveField,
  extractNestedProperty,
  resolveDirectRelation,
  resolveThroughRelation,
} from "./utils.js";

/**
 * Indexer: インデックス・メタファイル生成の中核クラス
 * - 各sourceのデータからインデックス/メタファイルを生成
 * - 多段リレーション・ドット記法・型安全なmeta抽出をサポート
 * - 共通化されたリレーション解決ロジックを利用
 */
export class Indexer<T extends SourceRecord = SourceRecord> {
  private loader: DataLoader<T>;
  private config: StaticQLConfig;
  private cache: Record<string, T[]> | null = null;

  constructor(loader: DataLoader<T>, config: StaticQLConfig) {
    this.loader = loader;
    this.config = config;
  }

  /**
   * 全sourceについてインデックス用レコード配列を生成 AsyncGenerator で返す
   * @returns AsyncGenerator<{ sourceName, records, indexFields }>
   */
  async *buildAll(): AsyncGenerator<{
    sourceName: string;
    records: any[];
    indexFields: string[];
  }> {
    for (const [sourceName, sourceDef] of Object.entries(this.config.sources)) {
      const { records, indexFields } = await this.buildSourceIndex(
        sourceName,
        sourceDef
      );
      yield { sourceName, records, indexFields };
    }
  }

  /**
   * 1つのsourceについてインデックス用レコード配列を生成する
   * @param sourceName
   * @param sourceDef
   * @returns Promise<any[]>
   */
  private async buildSourceIndex(
    sourceName: string,
    sourceDef: SourceConfig
  ): Promise<{ records: any[]; indexFields: string[] }> {
    // 対象ソースとリレーションソースをロード
    const loadKeys = new Set<string>([sourceName]);
    for (const rel of Object.values(sourceDef.relations ?? {})) {
      if (this.isThroughRelation(rel)) {
        loadKeys.add(rel.through);
        loadKeys.add(rel.to);
      } else {
        loadKeys.add(rel.to);
      }
    }
    const loadPromises = Array.from(loadKeys).map((k) => this.loader.load(k));
    const loadedArrays = await Promise.all(loadPromises);
    const dataMap = Array.from(loadKeys).reduce<Record<string, any[]>>(
      (acc, k, i) => ((acc[k] = loadedArrays[i]), acc),
      {}
    );

    // 参照用にソースデータをマップ化
    const directMaps: Record<string, Map<string, any[]>> = {};
    const throughToSourceMap: Record<string, Map<string, any[]>> = {};
    const targetMaps: Record<string, Map<string, any>> = {};

    for (const [key, rel] of Object.entries(sourceDef.relations ?? {})) {
      if (this.isThroughRelation(rel)) {
        // through リレーション
        const throughArr = dataMap[rel.through];
        const targetArr = dataMap[rel.to];

        const throughData = new Map<string, any[]>();
        for (const t of throughArr) {
          const keys = (resolveField(t, rel.throughForeignKey) ?? "")
            .split(" ")
            .filter(Boolean);

          for (const k of keys) {
            this.getOrCreateMapValue(throughData, k).push(t);
          }
        }
        throughToSourceMap[key] = throughData;

        const targetData = new Map<string, any>();
        for (const t of targetArr) {
          targetData.set(resolveField(t, rel.targetForeignKey) ?? "", t);
        }
        targetMaps[key] = targetData;
      } else {
        // direct リレーション
        const arr = dataMap[(rel as any).to];
        const targetArr = new Map<string, any[]>();
        for (const f of arr) {
          const fk = resolveField(f, (rel as any).foreignKey) ?? "";
          for (const k of fk.split(" ").filter(Boolean)) {
            this.getOrCreateMapValue(targetArr, k).push(f);
          }
        }
        directMaps[key] = targetArr;
      }
    }

    // リレーションをアタッチ
    const attached = dataMap[sourceName].map((row) => {
      const data: any = { ...row };

      for (const [key, rel] of Object.entries(sourceDef.relations ?? {})) {
        if (this.isThroughRelation(rel)) {
          const srcKey = resolveField(row, rel.sourceLocalKey) ?? "";
          const throughRows = throughToSourceMap[key].get(srcKey) || [];
          const targets = throughRows.flatMap((t) => {
            return (resolveField(t, rel.throughLocalKey) ?? "")
              .split(" ")
              .map((k) => targetMaps[key].get(k))
              .filter(Boolean);
          });

          data[key] =
            rel.type === "hasOneThrough" ? targets[0] ?? null : targets;
        } else {
          const localVal = resolveField(row, (rel as any).localKey) ?? "";
          const keys = localVal.split(" ").filter(Boolean);
          const matches = keys.flatMap((k) => directMaps[key].get(k) ?? []);

          data[key] =
            (rel as any).type === "hasOne" ? matches[0] ?? null : matches;
        }
      }

      return data;
    });

    // インデックス対象フィールドを決定
    const explicitIndex: string[] = sourceDef.index ?? [];

    // relationsごとに適切なインデックスキーを自動追加
    const relationIndex: string[] = [];
    if (sourceDef.relations) {
      for (const [relKey, rel] of Object.entries(sourceDef.relations)) {
        if (rel.type === "belongsTo" || rel.type === "belongsToMany") {
          // belongsTo: foreignKey（例: combinedHerbs.slug）
          relationIndex.push(rel.foreignKey);
        } else {
          // hasOne/hasMany/through: key.slug
          relationIndex.push(`${relKey}.slug`);
        }
      }
    }

    // throughリレーション対応: 他sourceからthrough先として参照されている場合、throughForeignKey, targetForeignKeyを追加
    for (const [otherSourceName, otherSourceDef] of Object.entries(
      this.config.sources
    )) {
      if (!otherSourceDef.relations) continue;
      for (const rel of Object.values(otherSourceDef.relations)) {
        if (
          typeof rel === "object" &&
          "through" in rel &&
          (rel.type === "hasOneThrough" || rel.type === "hasManyThrough")
        ) {
          if (rel.through === sourceName && rel.throughForeignKey !== "slug") {
            relationIndex.push(rel.throughForeignKey);
          } else if (rel.to === sourceName && rel.targetForeignKey !== "slug") {
            relationIndex.push(rel.targetForeignKey);
          }
        }
      }
    }

    // 明示指定とrelations由来を結合し重複除去
    const indexFields = Array.from(
      new Set([...explicitIndex, ...relationIndex])
    );

    // インデックス構築
    const records = attached.map((row) => {
      const values: Record<string, string> = {};
      for (const fld of indexFields) {
        const v = resolveField(row, fld);
        if (v != null && String(v) !== "") values[fld] = String(v);
      }
      return { slug: row.slug, values };
    });

    return { records, indexFields };
  }

  /**
   * リレーションが through か判定
   * @param rel
   * @returns
   */
  private isThroughRelation(rel: RelationConfig): rel is ThroughRelation {
    return (
      typeof rel === "object" &&
      "through" in rel &&
      (rel.type === "hasOneThrough" || rel.type === "hasManyThrough")
    );
  }

  /**
   * 未設定マップキーをセット
   * @param map
   * @param key
   * @returns
   */
  private getOrCreateMapValue<K, V>(map: Map<K, V[]>, key: K): V[] {
    let value = map.get(key);

    if (!value) {
      value = [];
      map.set(key, value);
    }

    return value;
  }

  /**
   * 全sourceのインデックス/メタファイルを指定ディレクトリに出力する
   * @param outputDir - 出力先ディレクトリ
   * @returns void
   * @throws ストレージ書き込み失敗時に例外
   */
  async saveTo(outputDir: string): Promise<void> {
    // Provider経由でファイル出力
    const provider: StorageProvider = (this.loader as any).provider;

    for await (const { sourceName, records, indexFields } of this.buildAll()) {
      const sourceDef = this.config.sources[sourceName];

      // Write index files per field (indexFields includes auto-added fields)
      for (const field of indexFields) {
        if (sourceDef.splitIndexByKey) {
          // 分割方式: output/{source_name}/index-{field}/{key_value}.json
          const dirPath = `${outputDir.replace(
            /\/$/,
            ""
          )}/${sourceName}/index-${field}`;

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
            await provider.writeFile(filePath, JSON.stringify(slugs, null, 2));
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

          await provider.writeFile(filePath, JSON.stringify(indexMap, null, 2));
        }
      }

      // ファイルリスト用インデックスファイル
      const slugIndexFilePath = `${outputDir.replace(
        /\/$/,
        ""
      )}/${sourceName}.index.json`;
      await provider.writeFile(
        slugIndexFilePath,
        JSON.stringify(
          records.map((r) => r.slug),
          null,
          2
        )
      );

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
   * 1レコードのmeta情報をリレーション・ドット記法含めて抽出する
   * @param row - 対象データレコード
   * @param sourceDef - source定義
   * @param relationData - 事前ロード済みのリレーションデータ
   * @returns meta情報オブジェクト
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
          relValue = resolveThroughRelation(
            row,
            rel,
            relationData[relKey].throughData,
            relationData[relKey].targetData
          );
        } else {
          relValue = resolveDirectRelation(
            row,
            rel,
            relationData[relKey].foreignData
          );
        }

        // Now, access the nested property using the utility
        if (Array.isArray(relValue)) {
          const values = extractNestedProperty(relValue, relProp);
          metaObj[field] = Array.from(new Set(values));
        } else if (relValue && typeof relValue === "object") {
          const arr = extractNestedProperty([relValue], relProp);
          // metaで指定されたプロパティが配列かどうかで判定
          const prop0 = relProp[0];
          const isArrayProp = Array.isArray(
            Array.isArray(relValue) ? relValue[0]?.[prop0] : relValue[prop0]
          );
          if (isArrayProp) {
            metaObj[field] = Array.from(new Set(arr));
          } else {
            metaObj[field] =
              arr.length === 1 ? arr[0] : Array.from(new Set(arr));
          }
        } else {
          metaObj[field] = undefined;
        }
      } else if (sourceDef.relations && sourceDef.relations[field]) {
        // Top-level relation (no dot)
        const rel = sourceDef.relations[field];
        let relValue: any;

        if (
          "through" in rel &&
          (rel.type === "hasOneThrough" || rel.type === "hasManyThrough")
        ) {
          relValue = resolveThroughRelation(
            row,
            rel,
            relationData[field].throughData,
            relationData[field].targetData
          );
        } else {
          relValue = resolveDirectRelation(
            row,
            rel,
            relationData[field].foreignData
          );
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
}
