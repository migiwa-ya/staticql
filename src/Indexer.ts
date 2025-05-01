import { DataLoader } from "./DataLoader.js";

/**
 * 差分更新用エントリ型
 */
export type DiffEntry = {
  status: "A" | "M" | "D" | "R";
  path: string;
  oldPath?: string;
};
import {
  StaticQLConfig,
  SourceRecord,
  SourceConfig,
  RelationConfig,
  ThroughRelation,
} from "./types";
import type { StorageProvider } from "./storage/StorageProvider";
import {
  getFieldIndexFilePath,
  getSourceIndexFilePath,
  getSplitIndexFilePath,
  getIndexDir,
  getSlugFromPath,
} from "./utils/path.js";
import { resolveField } from "./utils/field.js";

/**
 * Indexer: インデックス・メタファイル生成の中核クラス
 * - 各sourceのデータからインデックス/メタファイルを生成
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

          // utils.ts の getSplitIndexFilePath を利用
          for (const [keyValue, slugs] of Object.entries(keyMap)) {
            const filePath = getSplitIndexFilePath(
              outputDir.replace(/\/$/, ""),
              sourceName,
              field,
              keyValue
            );
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

          // utils.ts の getFieldIndexFilePath を利用
          const filePath = getFieldIndexFilePath(
            outputDir.replace(/\/$/, ""),
            sourceName,
            field
          );

          await provider.writeFile(filePath, JSON.stringify(indexMap, null, 2));
        }
      }

      // ファイルリスト用インデックスファイル
      const slugIndexFilePath = getSourceIndexFilePath(
        outputDir.replace(/\/$/, ""),
        sourceName
      );
      await provider.writeFile(
        slugIndexFilePath,
        JSON.stringify(
          records.map((r) => r.slug),
          null,
          2
        )
      );
    }
  }

  /**
   * 差分情報に基づき、関連インデックスファイルのみを更新する（スケルトン）
   * @param outputDir - 出力先ディレクトリ
   * @param diffEntries - 差分情報配列
   */
  async updateIndexesForFiles(
    outputDir: string,
    diffEntries: DiffEntry[]
  ): Promise<void> {
    // diffEntiries をソースごとに整理
    const sourceMap: Record<string, DiffEntry[]> = {};
    for (const entry of diffEntries) {
      const path = entry.path;
      for (const [sourceName, sourceDef] of Object.entries(
        this.config.sources
      )) {
        const baseDir = sourceDef.path.replace(/\*.*$/, "");
        const ext = sourceDef.path.split(".").pop();
        if (path.startsWith(baseDir) && (!ext || path.endsWith("." + ext))) {
          if (!sourceMap[sourceName]) sourceMap[sourceName] = [];
          sourceMap[sourceName].push(entry);
          break;
        }
      }
    }

    // 各sourceNameごとにA/M/R/Dのslugリストを抽出
    const perSourceSlugs: Record<
      string,
      {
        addOrUpdate: string[];
        delete: string[];
        rename: { oldSlug: string; newSlug: string }[];
      }
    > = {};

    for (const [sourceName, entries] of Object.entries(sourceMap)) {
      const sourceDef = this.config.sources[sourceName];
      const addOrUpdate: string[] = [];
      const deleteList: string[] = [];
      const renameList: { oldSlug: string; newSlug: string }[] = [];
      for (const entry of entries) {
        if (entry.status === "A" || entry.status === "M") {
          addOrUpdate.push(getSlugFromPath(sourceDef.path, entry.path));
        } else if (entry.status === "D") {
          // 削除はoldPathまたはpath
          deleteList.push(
            getSlugFromPath(sourceDef.path, entry.oldPath || entry.path)
          );
        } else if (entry.status === "R") {
          // リネームは両方
          renameList.push({
            oldSlug: getSlugFromPath(sourceDef.path, entry.oldPath || ""),
            newSlug: getSlugFromPath(sourceDef.path, entry.path),
          });
        }
      }
      perSourceSlugs[sourceName] = {
        addOrUpdate,
        delete: deleteList,
        rename: renameList,
      };
    }

    const provider: StorageProvider = (this.loader as any).provider;

    for (const [
      sourceName,
      { addOrUpdate, delete: deleteList, rename },
    ] of Object.entries(perSourceSlugs)) {
      const sourceDef = this.config.sources[sourceName];
      // インデックス対象フィールドを取得
      const { indexFields } = await this.buildSourceIndex(
        sourceName,
        sourceDef
      );

      // 追加・更新・リネーム新slug: レコードをロードしインデックス再生成
      const slugsToUpsert = [...addOrUpdate, ...rename.map((r) => r.newSlug)];
      let records: T[] = [];
      if (slugsToUpsert.length > 0) {
        records = await this.loader.loadBySlugs(sourceName, slugsToUpsert);
      }

      // 各indexFieldごとにインデックスファイルを更新
      for (const field of indexFields) {
        if (sourceDef.splitIndexByKey) {
          // 分割方式: 各slugの値ごとにファイルを再生成
          const keyMap: Record<string, Set<string>> = {};
          for (const rec of records) {
            const value = resolveField(rec, field);
            if (value == null) continue;
            for (const v of String(value).split(" ")) {
              if (!v) continue;
              if (!keyMap[v]) keyMap[v] = new Set();
              keyMap[v].add(rec.slug);
            }
          }
          // 書き出し
          for (const [keyValue, slugSet] of Object.entries(keyMap)) {
            const filePath = getSplitIndexFilePath(
              outputDir.replace(/\/$/, ""),
              sourceName,
              field,
              keyValue
            );
            await provider.writeFile(
              filePath,
              JSON.stringify(Array.from(slugSet), null, 2)
            );
          }
        } else {
          // 単一ファイル方式: indexMapを部分的に更新
          // 既存indexMapを読み込み
          const filePath = getFieldIndexFilePath(
            outputDir.replace(/\/$/, ""),
            sourceName,
            field
          );
          let indexMap: Record<string, string[]> = {};
          try {
            const raw = await provider.readFile(filePath);
            indexMap = JSON.parse(
              typeof raw === "string" ? raw : new TextDecoder().decode(raw)
            );
          } catch {
            indexMap = {};
          }

          // 対象slugの値でindexMapを更新
          for (const rec of records) {
            const value = resolveField(rec, field);
            if (value == null) continue;
            for (const v of String(value).split(" ")) {
              if (!v) continue;
              if (!indexMap[v]) indexMap[v] = [];
              if (!indexMap[v].includes(rec.slug)) indexMap[v].push(rec.slug);
            }
          }

          await provider.writeFile(filePath, JSON.stringify(indexMap, null, 2));
        }
      }

      // 削除slugリスト（delete/renameのoldSlug）
      const slugsToDelete = [...deleteList, ...rename.map((r) => r.oldSlug)];

      // 各indexFieldごとに削除slugをインデックスから除外
      for (const field of indexFields) {
        if (sourceDef.splitIndexByKey) {
          // 分割方式: 各slugの値ごとにファイルを削除または更新
          // indexディレクトリ: output/{source}/index-{field}/
          const indexDir = `${getIndexDir(
            outputDir
          )}/${sourceName}/index-${field}`;
          let files: string[] = [];
          try {
            files = await (provider as any).listFiles(indexDir);
          } catch {
            files = [];
          }
          for (const file of files) {
            let slugs: string[] = [];
            try {
              const raw = await provider.readFile(file);
              slugs = JSON.parse(
                typeof raw === "string" ? raw : new TextDecoder().decode(raw)
              );
            } catch {
              continue;
            }
            // 削除slugを除外
            const filtered = slugs.filter(
              (slug) => !slugsToDelete.includes(slug)
            );
            if (filtered.length === 0) {
              // 空になったらファイル削除
              if (provider.removeFile) {
                await provider.removeFile(file);
              }
            } else if (filtered.length !== slugs.length) {
              // 変更があれば上書き
              await provider.writeFile(file, JSON.stringify(filtered, null, 2));
            }
          }
        } else {
          // 単一ファイル方式: indexMapから該当slugを除外
          const filePath = getFieldIndexFilePath(
            outputDir.replace(/\/$/, ""),
            sourceName,
            field
          );
          let indexMap: Record<string, string[]> = {};
          try {
            const raw = await provider.readFile(filePath);
            indexMap = JSON.parse(
              typeof raw === "string" ? raw : new TextDecoder().decode(raw)
            );
          } catch {
            indexMap = {};
          }
          // 各値ごとにslugを除外
          for (const v of Object.keys(indexMap)) {
            indexMap[v] = indexMap[v].filter(
              (slug) => !slugsToDelete.includes(slug)
            );
            // 空配列になったら削除
            if (indexMap[v].length === 0) {
              delete indexMap[v];
            }
          }

          await provider.writeFile(filePath, JSON.stringify(indexMap, null, 2));
        }
      }

      // slugリストファイル（source.index.json）からも削除
      const slugIndexFilePath = getSourceIndexFilePath(
        outputDir.replace(/\/$/, ""),
        sourceName
      );

      let slugList: string[] = [];
      try {
        const raw = await provider.readFile(slugIndexFilePath);
        slugList = JSON.parse(
          typeof raw === "string" ? raw : new TextDecoder().decode(raw)
        );
      } catch {
        slugList = [];
      }

      // addOrUpdate/rename新slugは追加（重複除外）、delete/rename旧slugは除外
      const newSlugs = [...addOrUpdate, ...rename.map((r) => r.newSlug)];
      slugList = slugList.filter((slug) => !slugsToDelete.includes(slug));
      for (const slug of newSlugs) {
        if (!slugList.includes(slug)) slugList.push(slug);
      }
      await provider.writeFile(
        slugIndexFilePath,
        JSON.stringify(slugList, null, 2)
      );
    }
  }
}
