import { StaticQLConfig } from "../types";
import type { StorageProvider } from "./StorageProvider";
import { slugsToFilePaths } from "../utils/path.js";

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

    // 共通関数でslugフィルタ・パス生成
    return slugsToFilePaths(pattern, slugs);
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

  async removeFile(path: string): Promise<void> {
    throw new Error("removeFile is not supported in browser environment");
  }
}
