import { SourceConfigResolver as resolver } from "../SourceConfigResolver";
import type { StorageRepository } from "./StorageRepository";

/**
 * ブラウザ用 StorageProvider: public/ 配下のファイルを fetch で読み込む
 * - 書き込み・ファイル一覧取得は未サポート
 */
export class FetchRepository implements StorageRepository {
  baseUrl: string;

  constructor(baseUrl: string = "/", private resolver: resolver) {
    this.baseUrl = baseUrl.replace(/\/+$/, "") + "/";
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
    const rsc = this.resolver.resolveOne(sourceName ?? "");
    if (!rsc) return [];

    // indexes.all は slug の配列
    const slugs: string[] = rsc.indexes?.all
      ? await this.fetchIndexFile(rsc.indexes.all)
      : [];

    // 共通関数でslugフィルタ・パス生成
    return resolver.getSourcePathsBySlugs(pattern, slugs);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    throw new Error("writeFile is not supported in browser environment");
  }

  async removeFile(path: string): Promise<void> {
    throw new Error("removeFile is not supported in browser environment");
  }

  private async fetchIndexFile(indexPath: string): Promise<string[]> {
    // indexPath は public/ からの相対パス or 絶対パス
    const url = indexPath.startsWith("/")
      ? this.baseUrl + indexPath.replace(/^\/+/, "")
      : this.baseUrl + indexPath;
    const res = await fetch(url);
    if (!res.ok) return [];
    return await res.json();
  }
}
