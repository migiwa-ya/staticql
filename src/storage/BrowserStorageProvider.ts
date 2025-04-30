import type { StorageProvider } from "./StorageProvider";

/**
 * ブラウザ用 StorageProvider: public/ 配下のファイルを fetch で読み込む
 * - 書き込み・ファイル一覧取得は未サポート
 */
export class BrowserStorageProvider implements StorageProvider {
  baseUrl: string;
  schemaUrl: string;
  schemaCache: any | null = null;

  constructor(baseUrl: string = "/", schemaUrl: string = "/staticql.schema.json") {
    this.baseUrl = baseUrl.replace(/\/+$/, "") + "/";
    this.schemaUrl = schemaUrl.startsWith("/") ? schemaUrl : "/" + schemaUrl;
  }

  async ensureSchemaLoaded() {
    if (this.schemaCache) return;
    const url = this.baseUrl + this.schemaUrl.replace(/^\/+/, "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch schema: ${url}`);
    this.schemaCache = await res.json();
  }

  async readFile(path: string): Promise<string> {
    const url = this.baseUrl + path.replace(/^\/+/, "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch: ${url}`);
    return await res.text();
  }

  async exists(path: string): Promise<boolean> {
    const url = this.baseUrl + path.replace(/^\/+/, "");
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  }

  // pattern例: "herbs/*.md", "herbs/", "herbParts.yaml"
  async listFiles(pattern: string): Promise<string[]> {
    await this.ensureSchemaLoaded();
    // sourceName を pattern から推定（最初のスラッシュ/ドット/拡張子前まで）
    const m = pattern.match(/^([^\/\.\*]+)/);
    const sourceName = m ? m[1] : null;
    if (!sourceName || !this.schemaCache.sources[sourceName]) return [];

    // ワイルドカード除去
    const basePath = pattern.replace(/\*.*$/, "").replace(/\/$/, "") || (this.schemaCache.sources[sourceName].path || sourceName);

    // indexes.all は slug の配列
    const slugs: string[] = this.schemaCache.sources[sourceName]?.indexes?.all
      ? await this._fetchIndexFile(this.schemaCache.sources[sourceName].indexes.all)
      : [];

    // pattern の拡張子を抽出
    const extMatch = pattern.match(/\.(\w+)$/);
    const ext = extMatch ? "." + extMatch[1] : "";

    // slug からファイルパスを生成
    let files = slugs.map((slug) => {
      return `${basePath}/${slug}${ext}`;
    });

    // 最低限のフィルタ: 拡張子・ワイルドカード
    if (pattern.includes("*")) {
      const regex = new RegExp(
        "^" +
          pattern
            .replace(/\./g, "\\.")
            .replace(/\*/g, ".*")
            .replace(/\//g, "\\/") +
          "$"
      );
      files = files.filter((f) => regex.test(f));
    }

    return files;
  }

  async listFilesByIndex(
    sourceName: string,
    indexDir: string,
    pattern: string
  ): Promise<string[]> {
    await this.ensureSchemaLoaded();
    if (!this.schemaCache.sources[sourceName]) return [];

    // indexes.all は slug の配列
    const slugs: string[] = this.schemaCache.sources[sourceName]?.indexes?.all
      ? await this._fetchIndexFile(this.schemaCache.sources[sourceName].indexes.all)
      : [];

    // pattern の拡張子を抽出
    const extMatch = pattern.match(/\.(\w+)$/);
    const ext = extMatch ? "." + extMatch[1] : "";

    // ワイルドカード除去
    const basePath = pattern.replace(/\*.*$/, "").replace(/\/$/, "") || (this.schemaCache.sources[sourceName].path || sourceName);

    // slug からファイルパスを生成
    let files = slugs.map((slug) => {
      return `${basePath}/${slug}${ext}`;
    });

    // 最低限のフィルタ: 拡張子・ワイルドカード
    if (pattern.includes("*")) {
      const regex = new RegExp(
        "^" +
          pattern
            .replace(/\./g, "\\.")
            .replace(/\*/g, ".*")
            .replace(/\//g, "\\/") +
          "$"
      );
      files = files.filter((f) => regex.test(f));
    }

    return files;
  }

  async _fetchIndexFile(indexPath: string): Promise<string[]> {
    // indexPath は public/ からの相対パス or 絶対パス
    const url = indexPath.startsWith("/")
      ? this.baseUrl + indexPath.replace(/^\/+/, "")
      : this.baseUrl + indexPath;
    const res = await fetch(url);
    if (!res.ok) return [];
    return await res.json();
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    throw new Error("writeFile is not supported in browser environment");
  }
}
