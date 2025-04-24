import matter from "gray-matter";
import yaml from "js-yaml";
import type { ContentDBConfig, SourceConfig } from "./types";
import type { StorageProvider } from "./storage/StorageProvider";

export class DataLoader {
  private config: ContentDBConfig;
  private provider: StorageProvider;
  private cache: Map<string, any[]> = new Map();

  constructor(config: ContentDBConfig, provider: StorageProvider) {
    this.config = config;
    this.provider = provider;
  }

  /**
   * 指定した sourceName の全データをストレージからロードし、型バリデーション・キャッシュする
   * @param sourceName - 設定で定義された source 名
   * @returns データ配列
   * @throws 未知の source 名やスキーマ不一致時に例外
   */
  async load(sourceName: string): Promise<any[]> {
    if (this.cache.has(sourceName)) {
      return this.cache.get(sourceName)!;
    }

    const source = this.config.sources[sourceName];
    if (!source) throw new Error(`Unknown source: ${sourceName}`);

    const files = await this.provider.listFiles(source.path);
    const parsed = await Promise.all(
      files.map((f) => this.parseFile(f, source, f))
    );

    const flattened =
      Array.isArray(parsed) && Array.isArray(parsed[0])
        ? parsed.flat()
        : parsed;

    source.schema.parse(flattened);
    this.cache.set(sourceName, flattened);

    return flattened;
  }

  /**
   * 指定した sourceName, slug から1件のデータをロードし、型バリデーションする
   * @param sourceName - 設定で定義された source 名
   * @param slug - ファイル名等から生成される一意な識別子
   * @returns データオブジェクト
   * @throws 未知の source 名やファイル未発見・スキーマ不一致時に例外
   */
  async loadBySlug(sourceName: string, slug: string): Promise<any> {
    const source = this.config.sources[sourceName];
    if (!source) throw new Error(`Unknown source: ${sourceName}`);

    const ext = this.getExtname(source.path);

    const relativePath = slug.replace(/--/g, "/") + ext;
    const filePath = this.resolveFilePath(source.path, relativePath);

    try {
      const parsed = await this.parseFile(filePath, source, filePath);
      source.schema.parse([parsed]);
      return parsed;
    } catch (err) {
      throw new Error(`Failed to loadBySlug: ${filePath} — ${err}`);
    }
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
    source: SourceConfig,
    fullPath: string
  ): Promise<any> {
    const ext = this.getExtname(fullPath);
    let raw = await this.provider.readFile(fullPath);
    if (raw instanceof Uint8Array) {
      raw = new TextDecoder().decode(raw);
    }

    let parsed: any;

    if (source.type === "markdown") {
      const { data, content } = matter(raw);
      parsed = { ...data, content };
    } else if (source.type === "yaml") {
      parsed = yaml.load(raw);
    } else if (source.type === "json") {
      parsed = JSON.parse(raw);
    } else {
      throw new Error(`Unsupported file type: ${ext}`);
    }

    if (
      source.path.includes("*") &&
      !Array.isArray(parsed) &&
      typeof parsed === "object" &&
      parsed !== null
    ) {
      const slugFromPath = this.getSlugFromPath(source.path, filePath);

      if (!parsed.slug) {
        parsed.slug = slugFromPath;
      } else if (parsed.slug !== slugFromPath) {
        throw new Error(
          `slug mismatch: expected "${slugFromPath}", got "${parsed.slug}" in ${filePath}`
        );
      }
    }

    return parsed;
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

  /**
   * ファイルパスからslug（論理ID）を生成（Node.js非依存）
   * @param sourcePath - 設定で定義されたsourceのパス（glob含む）
   * @param filePath - 実際のファイルパス
   * @returns slug文字列（例: "matricaria-chamomilla"）
   */
  private getSlugFromPath(sourcePath: string, filePath: string): string {
    // sourcePath例: "tests/content-fixtures/herbs/*.md"
    // filePath例: "tests/content-fixtures/herbs/matricaria-chamomilla.md"
    // slug: "matricaria-chamomilla"
    const ext = this.getExtname(filePath);
    const baseDir = this.extractBaseDir(sourcePath);
    let rel = filePath.startsWith(baseDir)
      ? filePath.slice(baseDir.length)
      : filePath;
    if (rel.startsWith("/")) rel = rel.slice(1);
    const slug = rel.replace(ext, "").replace(/\//g, "--");
    return slug;
  }

  /**
   * sourcePathからワイルドカードより前のディレクトリ部分を抽出
   * @param globPath - globを含むパス
   * @returns ディレクトリパス
   */
  private extractBaseDir(globPath: string): string {
    const parts = globPath.split("/");
    const index = parts.findIndex((part) => part.includes("*"));
    if (index === -1) return globPath;
    return parts.slice(0, index).join("/") + "/";
  }

  /**
   * sourceGlob, relativePathから論理パスを生成
   * @param sourceGlob - globを含むパス
   * @param relativePath - 相対パス
   * @returns 論理パス
   */
  private resolveFilePath(sourceGlob: string, relativePath: string): string {
    const baseDir = this.extractBaseDir(sourceGlob);
    return baseDir + relativePath;
  }
}
