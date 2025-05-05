import { Validator } from "./validator/Validator.js";
import { parseByType } from "./parser/index.js";
import type { StorageRepository } from "./repository/StorageRepository.js";
import {
  ResolvedSourceConfig as rsc,
  SourceConfigResolver as resolver,
} from "./SourceConfigResolver.js";

export class SourceLoader<T> {
  constructor(
    private repository: StorageRepository,
    private resolver: resolver,
    private validator: Validator
  ) {}

  async loadBySourceName(sourceName: string): Promise<T[]> {
    const rsc = this.resolver.resolveOne(sourceName);
    const filePaths = await this.repository.listFiles(rsc.pattern);
    const data: any = [];

    for (const filePath of filePaths) {
      data.push(await this.load(filePath, rsc));
    }

    const flattened =
      Array.isArray(data) && Array.isArray(data[0]) ? data.flat() : data;

    return flattened;
  }

  async load(filePath: string, rsc: rsc) {
    const rawContent = await this.repository.readFile(filePath);
    const parsed = await parseByType(rsc.type, { rawContent });
    let validated = [];

    if (Array.isArray(parsed)) {
      parsed.map((p) => this.validator.validate(p, rsc.schema));
      validated = parsed.flat();
    } else {
      parsed.slug = resolver.getSlugFromPath(rsc.pattern, filePath);
      this.validator.validate(parsed, rsc.schema);
      validated = parsed;
    }

    return validated;
  }

  /**
   * 指定した sourceName, slug から1件のデータをロードし、型バリデーションする
   * ファイル内に複数データ（配列）がある場合はslug一致要素を返す
   * @param sourceName - 設定で定義された source 名
   * @param slug - ファイル名等から生成される一意な識別子
   * @returns データオブジェクト
   * @throws 未知の source 名やファイル未発見・スキーマ不一致時に例外
   */
  async loadBySlug(sourceName: string, slug: string): Promise<T> {
    const rsc = this.resolver.resolveOne(sourceName);
    if (!rsc) throw new Error(`Unknown source: ${sourceName}`);

    let filePath: string;

    // glob（*）を含む場合は共通関数でパス解決
    if (rsc.pattern.includes("*")) {
      filePath = resolver.getSourcePathsBySlugs(rsc.pattern, [slug])[0];
    } else {
      // それ以外はrsc.pathをそのまま使う
      filePath = rsc.pattern;
    }

    try {
      const parsed = await this.parseFile(filePath, rsc, filePath);

      // 配列の場合はslug一致要素を返す
      if (Array.isArray(parsed)) {
        const found = parsed.find((item) => item && item.slug === slug);
        if (!found) throw new Error(`slug not found in file: ${filePath}`);

        this.validator.validate(found, rsc.schema);

        return found as T;
      } else {
        this.validator.validate(parsed, rsc.schema);

        return parsed as T;
      }
    } catch (err) {
      throw new Error(`Failed to loadBySlug: ${filePath} — ${err}`);
    }
  }

  /**
   * 指定した sourceName, slugs 配列から該当するデータをまとめて取得する
   * @param sourceName - 設定で定義された source 名
   * @param slugs - 取得したいslugの配列
   * @returns slugに一致するデータ配列（見つかったもののみ返す）
   */
  async loadBySlugs(sourceName: string, slugs: string[]): Promise<T[]> {
    // slugごとにloadBySlugを並列実行し、見つかったものだけ返す
    const results = await Promise.allSettled(
      slugs.map((slug) => this.loadBySlug(sourceName, slug))
    );

    return results
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<T>> => r.status === "fulfilled"
      )
      .map((r) => r.value);
  }

  /**
   * 1ファイルをパースし、型・slug整合性を検証してデータオブジェクト化する
   * @param filePath - ファイルのパス
   * @param source - SourceConfig オブジェクト
   * @param fullPath - 実際のファイルパス
   * @returns パース済みデータ
   * @throws サポート外のファイル種別やslug不整合時に例外
   */
  private async parseFile(
    filePath: string,
    rsc: rsc,
    fullPath: string
  ): Promise<T> {
    const ext = this.getExtname(fullPath);
    let raw = await this.repository.readFile(fullPath);
    let parsed = await parseByType(rsc.type, { rawContent: raw });

    if (
      rsc.pattern.includes("*") &&
      !Array.isArray(parsed) &&
      typeof parsed === "object" &&
      parsed !== null
    ) {
      const slugFromPath = resolver.getSlugFromPath(rsc.pattern, filePath);

      // 型ガード: parsedはRecord<string, unknown>型として扱う
      const parsedObj = parsed as Record<string, unknown>;
      if (!parsedObj.slug) {
        parsedObj.slug = slugFromPath;
      } else if (parsedObj.slug !== slugFromPath) {
        throw new Error(
          `slug mismatch: expected "${slugFromPath}", got "${parsedObj.slug}" in ${filePath}`
        );
      }

      parsed = parsedObj;
    }

    return parsed as T;
  }

  /**
   * パス文字列から拡張子を取得
   * @param p - パス文字列
   * @returns 拡張子（例: ".md"）
   */
  private getExtname(p: string): string {
    const i = p.lastIndexOf(".");
    if (i === -1) return "";

    return p.slice(i);
  }
}
