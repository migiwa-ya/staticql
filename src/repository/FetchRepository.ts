import { SourceConfigResolver as Resolver } from "../SourceConfigResolver";
import { parsePrefixDict } from "../utils/normalize.js";
import { joinPath, toI, toP } from "../utils/path.js";
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
    const rsc = allRSCs.find((r) => pattern.startsWith(r.pattern));
    if (!rsc) return [];

    const indexDir = `index/${rsc.name}.slug`;
    const prefixIndexLines = await this.readAllIndexesRemote(indexDir);
    const slugs = prefixIndexLines.map((line) => line.v).filter(Boolean);

    let paths: string[];
    if (pattern.includes("*")) {
      paths = Resolver.getSourcePathsBySlugs(pattern, slugs);
    } else {
      paths = slugs.map((slug) => rsc.pattern.replace("*", slug));
    }

    return paths;
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
   * Not supported in browser.
   */
  async removeDir(path: string): Promise<void> {
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

  /**
   * Opens a file as a ReadableStream.
   *
   * @param path - Relative path to the file (from the repository base directory)
   * @returns Promise that resolves to a ReadableStream for the file contents
   */
  async openFileStream(path: string): Promise<ReadableStream> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`Failed to fetch ${path}`);
    return res.body!;
  }

  /**
   * Remote (fetch-based) version of recursive prefix index traversal.
   */
  private async readAllIndexesRemote(dir: string): Promise<any[]> {
    const results = [];

    try {
      const indexUrl = toI(this.baseUrl, dir);
      const indexRes = await fetch(indexUrl);
      if (indexRes.ok) {
        const indexData = await indexRes.text();
        const flattened = this.flatPrefixIndexLine(
          indexData
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        );
        results.push(...flattened);
      }
    } catch {}

    try {
      const prefixesUrl = toP(this.baseUrl, dir);
      const prefixesRes = await fetch(prefixesUrl);
      if (prefixesRes.ok) {
        const prefixesData = await prefixesRes.text();
        const prefixes = parsePrefixDict(prefixesData);
        for (const prefix of prefixes) {
          const subdir = joinPath(dir, prefix);
          const subResults = await this.readAllIndexesRemote(subdir);
          results.push(...subResults);
        }
      }
    } catch {}

    return results;
  }

  private flatPrefixIndexLine(unflattened: any[]) {
    const seen = new Set<string>();
    const flattened = [];

    for (const item of unflattened) {
      for (const [key, value] of Object.entries(item.ref)) {
        if (!seen.has(key)) {
          seen.add(key);
          flattened.push({
            v: item.v,
            vs: item.vs,
            ref: { [key]: value },
          });
        }
      }
    }
    return flattened;
  }
}
