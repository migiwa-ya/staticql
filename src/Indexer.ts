import { resolveField } from "./utils/field.js";
import {
  Relation,
  SourceConfigResolver as resolver,
  SourceRecord,
  ThroughRelation,
} from "./SourceConfigResolver.js";
import { StorageRepository } from "./repository/StorageRepository.js";
import { SourceLoader } from "./SourceLoader";
import { LoggerProvider } from "./logger/LoggerProvider";

/**
 * 差分更新用エントリ型
 */
export type DiffEntry = {
  status: "A" | "M" | "D" | "R";
  path: string;
  oldPath?: string;
};

/**
 * Indexer: インデックス生成の中核クラス
 */
export class Indexer {
  public static indexPrefix = "index";

  constructor(
    private readonly sourceLoader: SourceLoader<SourceRecord>,
    private readonly repository: StorageRepository,
    private readonly resolver: resolver,
    private readonly logger: LoggerProvider
  ) {}

  async getSplitIndexes(sourceName: string, field: string) {
    const indexDir = Indexer.getSplitIndexDir(sourceName, field);
    const indexPaths = await this.repository.listFiles(indexDir);
    let indexMap: Record<string, string[]> = {};

    for (const path of indexPaths) {
      const key = path.replace(/^.*\//, "").replace(/\.json$/, "");
      const raw = await this.repository.readFile(path);
      indexMap[key] = JSON.parse(raw);
    }

    return Object.values(indexMap).length === 0 ? null : indexMap;
  }

  async getSplitIndexPaths(sourceName: string, field: string) {
    const indexDir = Indexer.getSplitIndexDir(sourceName, field);
    const indexPaths = await this.repository.listFiles(indexDir);

    return indexPaths;
  }

  async getSplitIndex(sourceName: string, field: string, key: string) {
    const path = Indexer.getSplitIndexFilePath(sourceName, field, key);
    let matched: string[] | null;

    try {
      const raw = await this.repository.readFile(path);
      matched = JSON.parse(raw);
    } catch (e) {
      this.logger.info(`インデックスファイルが見つかりません`, {
        sourceName,
        path,
      });
      matched = null;
    }

    return matched;
  }

  async getFieldIndexes(sourceName: string, field: string) {
    let indexMap: Record<string, string[]> | null = null;
    const path = Indexer.getFieldIndexFilePath(sourceName, field);

    try {
      const raw = await this.repository.readFile(path);
      indexMap = JSON.parse(raw);
    } catch (e) {
      this.logger.info(`インデックスファイルが見つかりません`, {
        sourceName,
        path,
      });
      indexMap = null;
    }

    return indexMap;
  }

  async getFieldIndex(sourceName: string, field: string, key: string) {
    const indexes = await this.getFieldIndexes(sourceName, field);
    if (!indexes) return null;

    for (const [keyValue, index] of Object.entries(indexes)) {
      if (keyValue === key) return index;
    }

    this.logger.info(`インデックスファイルが見つかりません`, {
      sourceName,
      field,
    });

    return null;
  }

  async getSlugIndexes(sourceName: string) {
    const path = Indexer.getSlugIndexFilePath(sourceName);
    let indexes: string[] | null = null;

    try {
      const raw = await this.repository.readFile(path);
      indexes = JSON.parse(raw);
    } catch (e) {
      this.logger.info(`インデックスファイルが見つかりません`, {
        sourceName,
      });
      indexes = null;
    }

    return indexes;
  }

  /**
   * 全sourceについてインデックス用レコード配列を生成 AsyncGenerator で返す
   * @returns AsyncGenerator<{ sourceName, records, indexFields }>
   */
  async *build(): AsyncGenerator<{
    sourceName: string;
    records: any[];
    indexFields: string[];
  }> {
    const sourceCnofigs = this.resolver.resolveAll();

    for (const { name } of sourceCnofigs) {
      const { records, indexFields } = await this.buildIndexRecords(name);

      yield { sourceName: name, records, indexFields };
    }
  }

  /**
   * 1つのsourceについてインデックス用レコード配列を生成する
   * @param sourceName
   * @returns Promise<any[]>
   */
  private async buildIndexRecords(
    sourceName: string
  ): Promise<{ records: any[]; indexFields: string[] }> {
    const rsc = this.resolver.resolveOne(sourceName);
    const relations = rsc.relations ?? {};

    // 対象ソースとリレーションソースをロード
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
      Array.from(loadKeys).map((k) => this.sourceLoader.loadBySourceName(k))
    );
    const dataMap = Array.from(loadKeys).reduce<Record<string, any[]>>(
      (acc, k, i) => ((acc[k] = loadedArrays[i]), acc),
      {}
    );

    // ソースデータをマップ化（リレーション用）
    const directMaps: Record<string, Map<string, any[]>> = {};
    const throughToSourceMap: Record<string, Map<string, any[]>> = {};
    const targetMaps: Record<string, Map<string, any>> = {};
    for (const [key, rel] of Object.entries(relations)) {
      if (this.isThroughRelation(rel)) {
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
        const arr = dataMap[rel.to];
        const targetArr = new Map<string, any[]>();
        for (const f of arr) {
          const fk = resolveField(f, rel.foreignKey) ?? "";
          for (const k of fk.split(" ").filter(Boolean)) {
            this.getOrCreateMapValue(targetArr, k).push(f);
          }
        }
        directMaps[key] = targetArr;
      }
    }

    // リレーションのアタッチ
    const attached = dataMap[sourceName].map((row) => {
      const data: any = { ...row };
      for (const [key, rel] of Object.entries(relations)) {
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
          const localVal = resolveField(row, rel.localKey) ?? "";
          const keys = localVal.split(" ").filter(Boolean);
          const matches = keys.flatMap((k) => directMaps[key].get(k) ?? []);
          data[key] = rel.type === "hasOne" ? matches[0] ?? null : matches;
        }
      }

      return data;
    });

    // console.log(attached)

    // インデックス対象を抽出
    const indexFields = Array.from(
      new Set([
        ...Object.keys(rsc.indexes?.fields ?? {}),
        ...Object.keys(rsc.indexes?.split ?? {}),
      ])
    );

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
  private isThroughRelation(rel: Relation): rel is ThroughRelation {
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
   * @returns void
   * @throws ストレージ書き込み失敗時に例外
   */
  async save(): Promise<void> {
    for await (const { sourceName, records, indexFields } of this.build()) {
      const rsc = this.resolver.resolveOne(sourceName);
      const indexes = rsc.indexes ?? {};

      for (const field of indexFields) {
        const splitPrefix = indexes.split?.[field];
        const fieldPath = indexes.fields?.[field];

        if (splitPrefix) {
          // 分割ファイルインデックス保存

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
            const filePath = `${splitPrefix}${keyValue}.json`;
            await this.repository.writeFile(filePath, JSON.stringify(slugs));
          }
        } else if (fieldPath) {
          // 単一ファイルインデックス保存

          const indexMap: Record<string, string[]> = {};
          for (const rec of records) {
            const value = rec.values[field];
            if (value == null) continue;
            for (const v of value.split(" ")) {
              if (!v) continue;
              if (!indexMap[v]) indexMap[v] = [];
              indexMap[v].push(rec.slug);
            }
          }
          await this.repository.writeFile(fieldPath, JSON.stringify(indexMap));
        }
      }

      // slug インデックス
      if (indexes.all) {
        await this.repository.writeFile(
          indexes.all,
          JSON.stringify(records.map((r) => r.slug))
        );
      }
    }
  }

  /**
   * 差分情報に基づき、関連インデックスファイルのみを更新する（スケルトン）
   * @param outputDir - 出力先ディレクトリ
   * @param diffEntries - 差分情報配列
   */
  async updateIndexesForFiles(diffEntries: DiffEntry[]): Promise<void> {
    const sourceMap: Record<string, DiffEntry[]> = {};
    for (const entry of diffEntries) {
      const path = entry.path;
      for (const rsc of this.resolver.resolveAll()) {
        const baseDir = rsc.pattern?.replace(/\*.*$/, "") ?? "";
        const ext = rsc.pattern?.split(".").pop();
        if (path.startsWith(baseDir) && (!ext || path.endsWith("." + ext))) {
          if (!sourceMap[rsc.name]) sourceMap[rsc.name] = [];
          sourceMap[rsc.name].push(entry);
          break;
        }
      }
    }

    for (const [sourceName, entries] of Object.entries(sourceMap)) {
      const rsc = this.resolver.resolveOne(sourceName);
      const slugsToAdd: string[] = [];
      const slugsToDel: string[] = [];
      const slugRenames: { oldSlug: string; newSlug: string }[] = [];
      for (const entry of entries) {
        if (entry.status === "A" || entry.status === "M") {
          slugsToAdd.push(resolver.getSlugFromPath(rsc.pattern!, entry.path));
        } else if (entry.status === "D") {
          slugsToDel.push(resolver.getSlugFromPath(rsc.pattern!, entry.path));
        } else if (entry.status === "R") {
          slugRenames.push({
            oldSlug: resolver.getSlugFromPath(
              rsc.pattern!,
              entry.oldPath || ""
            ),
            newSlug: resolver.getSlugFromPath(rsc.pattern!, entry.path),
          });
        }
      }

      const indexFields = Object.keys({
        ...(rsc.indexes?.fields ?? {}),
        ...(rsc.indexes?.split ?? {}),
      });

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
          const keyMap: Record<string, Set<string>> = {};
          for (const rec of records) {
            const value = resolveField(rec, field);
            if (value == null) continue;
            for (const v of String(value).split(" ")) {
              if (!v) continue;
              keyMap[v] ??= new Set();
              keyMap[v].add(rec.slug);
            }
          }

          for (const [keyValue, slugSet] of Object.entries(keyMap)) {
            const path = `${splitPrefix}${keyValue}.json`;
            await this.repository.writeFile(
              path,
              JSON.stringify([...slugSet], null, 2)
            );
          }
        } else if (fieldPath) {
          let indexMap: Record<string, string[]> = {};
          try {
            const raw = await this.repository.readFile(fieldPath);
            indexMap = JSON.parse(
              typeof raw === "string" ? raw : new TextDecoder().decode(raw)
            );
          } catch {}

          for (const rec of records) {
            const value = resolveField(rec, field);
            if (value == null) continue;
            for (const v of String(value).split(" ")) {
              if (!v) continue;
              indexMap[v] ??= [];
              if (!indexMap[v].includes(rec.slug)) indexMap[v].push(rec.slug);
            }
          }

          await this.repository.writeFile(
            fieldPath,
            JSON.stringify(indexMap, null, 2)
          );
        }
      }

      const slugsToRemove = [
        ...slugsToDel,
        ...slugRenames.map((r) => r.oldSlug),
      ];
      for (const field of indexFields) {
        const splitPrefix = rsc.indexes?.split?.[field];
        const fieldPath = rsc.indexes?.fields?.[field];

        if (splitPrefix) {
          const indexDir = Indexer.getSplitIndexDir(sourceName, field);
          let files: string[] = [];
          try {
            files = await (this.repository as any).listFiles(indexDir);
          } catch {}

          for (const file of files) {
            let slugs: string[] = [];
            try {
              const raw = await this.repository.readFile(file);
              slugs = JSON.parse(
                typeof raw === "string" ? raw : new TextDecoder().decode(raw)
              );
            } catch {
              continue;
            }
            const filtered = slugs.filter((s) => !slugsToRemove.includes(s));
            if (filtered.length === 0) {
              await this.repository.removeFile(file);
            } else if (filtered.length !== slugs.length) {
              await this.repository.writeFile(
                file,
                JSON.stringify(filtered, null, 2)
              );
            }
          }
        } else if (fieldPath) {
          let indexMap: Record<string, string[]> = {};
          try {
            const raw = await this.repository.readFile(fieldPath);
            indexMap = JSON.parse(
              typeof raw === "string" ? raw : new TextDecoder().decode(raw)
            );
          } catch {}

          for (const v of Object.keys(indexMap)) {
            indexMap[v] = indexMap[v].filter((s) => !slugsToRemove.includes(s));
            if (indexMap[v].length === 0) delete indexMap[v];
          }

          await this.repository.writeFile(
            fieldPath,
            JSON.stringify(indexMap, null, 2)
          );
        }
      }

      const slugPath = rsc.indexes?.all;
      if (slugPath) {
        let slugList: string[] = [];
        try {
          const raw = await this.repository.readFile(slugPath);
          slugList = JSON.parse(
            typeof raw === "string" ? raw : new TextDecoder().decode(raw)
          );
        } catch {}

        const newSlugs = [...slugsToAdd, ...slugRenames.map((r) => r.newSlug)];
        slugList = slugList.filter((s) => !slugsToRemove.includes(s));
        for (const s of newSlugs) {
          if (!slugList.includes(s)) slugList.push(s);
        }
        await this.repository.writeFile(
          slugPath,
          JSON.stringify(slugList, null, 2)
        );
      }
    }
  }

  /**
   * 分割インデックスファイルのパスを生成
   * @param outputDir - 出力ディレクトリ
   * @param sourceName - ソース名
   * @param field - インデックスフィールド名
   * @param keyValue - キー値
   * @returns 例: output/herbs/index-name/カモミール.json
   */
  static getSplitIndexFilePath(
    sourceName: string,
    field: string,
    keyValue: string
  ): string {
    return `${this.getSplitIndexDir(sourceName, field)}${keyValue}.json`;
  }

  static getSplitIndexDir(sourceName: string, field: string): string {
    return `${this.indexPrefix}/${sourceName}/index-${field}/`;
  }

  /**
   * フィールド単位インデックスファイルのパスを生成
   * @param outputDir - 出力ディレクトリ
   * @param sourceName - ソース名
   * @param field - インデックスフィールド名
   * @returns 例: output/herbs.index-name.json
   */
  static getFieldIndexFilePath(sourceName: string, field: string): string {
    return `${this.indexPrefix}/${sourceName}.index-${field}.json`;
  }

  /**
   * ソース全体インデックスファイルのパスを生成
   * @param outputDir - 出力ディレクトリ
   * @param sourceName - ソース名
   * @returns 例: output/herbs.index.json
   */
  static getSlugIndexFilePath(sourceName: string): string {
    return `${this.indexPrefix}/${sourceName}.index.json`;
  }
}
