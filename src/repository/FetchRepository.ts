import { SourceConfigResolver as Resolver } from "../SourceConfigResolver";
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
  resolver?: Resolver;

  constructor(baseUrl: string = "/") {
    this.baseUrl = baseUrl.replace(/\/+$/, "") + "/";
  }

  setResolver(resolver: Resolver) {
    this.resolver = resolver;
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
    const allRSCs = this.resolver?.resolveAll() ?? [];
    const rsc = allRSCs.find((r) =>
      pattern.startsWith(r.indexes?.all ?? r.pattern)
    );
    if (!rsc) return [];

    if (rsc.indexes?.split) {
      for (const [field, prefix] of Object.entries(rsc.indexes.split)) {
        if (pattern.startsWith(prefix)) {
          const metaUrl = this.baseUrl + `${prefix}_meta.json`;
          const res = await fetch(metaUrl);
          if (!res.ok) return [];
          const keys: string[] = await res.json();
          return keys.map((key) => `${prefix}${key}.json`);
        }
      }
    }

    const slugs: string[] = rsc.indexes?.all
      ? await this.fetchIndexFile(rsc.indexes.all)
      : [];

    return Resolver.getSourcePathsBySlugs(pattern, slugs);
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
