import { StaticQLConfig } from "../types";
import type { StorageProvider } from "./StorageProvider";

/**
 * ブラウザ用 StorageProvider: public/ 配下のファイルを fetch で読み込む
 * - 書き込み・ファイル一覧取得は未サポート
 */
export class BrowserStorageProvider implements StorageProvider {
  baseUrl: string;
  schema: StaticQLConfig;

  constructor(baseUrl: string = "/", schema: StaticQLConfig) {
    this.baseUrl = baseUrl.replace(/\/+$/, "") + "/";
    this.schema = schema;
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
    // sourceName を pattern から推定
    const m = pattern.match(/^([^\/\.\*]+)/);
    const sourceName = m ? m[1] : null;
    if (!sourceName || !this.schema.sources[sourceName]) return [];
    // listFilesByIndexにバイパス
    return this.listFilesByIndex(sourceName, "", pattern);
  }

  async listFilesByIndex(
    sourceName: string,
    indexDir: string,
    pattern: string
  ): Promise<string[]> {
    if (!this.schema.sources[sourceName]) return [];

    // indexes.all は slug の配列
    const slugs: string[] = this.schema.sources[sourceName]?.indexes?.all
      ? await this._fetchIndexFile(this.schema.sources[sourceName].indexes.all)
      : [];

    // pattern の拡張子を抽出
    const extMatch = pattern.match(/\.(\w+)$/);
    const ext = extMatch ? "." + extMatch[1] : "";

    // ワイルドカード除去
    const basePath =
      pattern.replace(/\*.*$/, "").replace(/\/$/, "") ||
      this.schema.sources[sourceName].path ||
      sourceName;

    // slugフィルタ: patternをslugの--区切りに対応した正規表現に変換
    let filteredSlugs = slugs;
    if (pattern.includes("*")) {
      // patternからワイルドカード部分のみ抽出
      // 例: reports/**/*.md → '**/*.md'
      const wcIdx = pattern.indexOf("*");
      let slugPattern = pattern.slice(wcIdx);
      // ワイルドカード部分の / を -- に変換
      slugPattern = slugPattern.replace(/\//g, "--");
      // 拡張子を除去
      slugPattern = slugPattern.replace(/\.[^\.]+$/, "");
      // **, * を正規表現に変換
      slugPattern = slugPattern
        .replace(/\*\*/g, "([\\w-]+(--)?)*")
        .replace(/\*/g, "[\\w-]+");
      const regex = new RegExp("^" + slugPattern + "$");
      filteredSlugs = slugs
        .filter((slug) => regex.test(slug))
        .map((slug) => slug.replace("--", "/"));
    }

    // slug からファイルパスを生成
    const files = filteredSlugs.map((slug) => {
      return `${basePath}/${slug}${ext}`;
    });

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
