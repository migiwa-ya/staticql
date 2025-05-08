import { SourceConfigResolver as resolver } from "../SourceConfigResolver";
import type { StorageRepository } from "./StorageRepository";

/**
 * FetchRepository: A browser-compatible StorageRepository implementation.
 *
 * This implementation uses `fetch()` to load files under a public directory.
 *
 * ⚠ Write, delete, and full file listing are not supported in browser environments.
 */
export class FetchRepository implements StorageRepository {
  baseUrl: string;

  constructor(baseUrl: string = "/", private resolver: resolver) {
    this.baseUrl = baseUrl.replace(/\/+$/, "") + "/";
  }

  /**
   * Reads a file from the public directory using fetch.
   *
   * @param path - Relative path from base URL.
   * @returns The file contents as text.
   * @throws If fetch fails or response is not OK.
   */
  async readFile(path: string): Promise<string> {
    const url = this.baseUrl + path.replace(/^\/+/, "");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch: ${url}`);
    return await res.text();
  }

  /**
   * Checks if a file exists by sending a HEAD request.
   *
   * @param path - Relative path from base URL.
   * @returns True if the file is accessible; false otherwise.
   */
  async exists(path: string): Promise<boolean> {
    const url = this.baseUrl + path.replace(/^\/+/, "");
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  }

  /**
   * Retrieves a list of file paths matching a pattern.
   *
   * This works by:
   * - Inferring the source name from the pattern.
   * - Using the resolved source config to locate the slug index file.
   * - Converting slugs to full paths using the resolver.
   *
   * @param pattern - A glob-style pattern like "herbs/*.md" or "states.yaml".
   * @returns List of matching file paths (relative to base).
   */
  async listFiles(pattern: string): Promise<string[]> {
    const m = pattern.match(/^([^\/\.\*]+)/);
    const sourceName = m ? m[1] : null;
    const rsc = this.resolver.resolveOne(sourceName ?? "");
    if (!rsc) return [];

    const slugs: string[] = rsc.indexes?.all
      ? await this.fetchIndexFile(rsc.indexes.all)
      : [];

    return resolver.getSourcePathsBySlugs(pattern, slugs);
  }

  /**
   * Not supported in browser.
   */
  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    throw new Error("writeFile is not supported in browser environment");
  }

  /**
   * Not supported in browser.
   */
  async removeFile(path: string): Promise<void> {
    throw new Error("removeFile is not supported in browser environment");
  }

  /**
   * Internal helper to fetch a JSON index file (typically a list of slugs).
   *
   * @param indexPath - Relative or absolute path to index file.
   * @returns Parsed slug list or empty array on failure.
   */
  private async fetchIndexFile(indexPath: string): Promise<string[]> {
    const url = indexPath.startsWith("/")
      ? this.baseUrl + indexPath.replace(/^\/+/, "")
      : this.baseUrl + indexPath;

    const res = await fetch(url);
    if (!res.ok) return [];
    return await res.json();
  }
}
