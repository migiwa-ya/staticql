import { CacheProvider } from "../cache/CacheProvider.js";
import { SourceConfigResolver as Resolver } from "../SourceConfigResolver.js";
import type { StorageRepository } from "./StorageRepository.js";

/**
 * CachedRepository: wraps any StorageRepository with a CacheProvider layer.
 *
 * Caches readFile, openFileStream, and exists results so that subsequent
 * accesses for the same path skip the underlying I/O (e.g. HTTP fetch).
 *
 * Usage:
 * ```ts
 * import { FetchRepository } from "staticql/repo/fetch";
 * import { CachedRepository } from "staticql/repo/cached";
 * import { IndexedDBCacheProvider } from "staticql/cache/indexeddb";
 *
 * const repo = new CachedRepository(
 *   new FetchRepository("https://cdn.example.com/"),
 *   new IndexedDBCacheProvider({ version: "abc123" })
 * );
 * ```
 */
export class CachedRepository implements StorageRepository {
  constructor(
    private readonly inner: StorageRepository,
    private readonly cache: CacheProvider
  ) {}

  setResolver(resolver: Resolver): void {
    if (this.inner.setResolver) {
      this.inner.setResolver(resolver);
    }
  }

  async readFile(path: string): Promise<string> {
    const cacheKey = `file:${path}`;

    if (await this.cache.has(cacheKey)) {
      return (await this.cache.get<string>(cacheKey))!;
    }

    const content = await this.inner.readFile(path);
    await this.cache.set(cacheKey, content);
    return content;
  }

  async openFileStream(path: string): Promise<ReadableStream> {
    const cacheKey = `file:${path}`;

    let content: string;
    if (await this.cache.has(cacheKey)) {
      content = (await this.cache.get<string>(cacheKey))!;
    } else {
      content = await this.inner.readFile(path);
      await this.cache.set(cacheKey, content);
    }

    // Convert cached string content to a ReadableStream
    const bytes = new TextEncoder().encode(content);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async exists(path: string): Promise<boolean> {
    const cacheKey = `file:${path}`;

    // If content is already cached, we know it exists
    if (await this.cache.has(cacheKey)) {
      return true;
    }

    return this.inner.exists(path);
  }

  async listFiles(pattern: string): Promise<string[]> {
    const cacheKey = `list:${pattern}`;

    if (await this.cache.has(cacheKey)) {
      return (await this.cache.get<string[]>(cacheKey))!;
    }

    const files = await this.inner.listFiles(pattern);
    await this.cache.set(cacheKey, files);
    return files;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    return this.inner.writeFile(path, data);
  }

  async removeFile(path: string): Promise<void> {
    await this.cache.delete(`file:${path}`);
    return this.inner.removeFile(path);
  }

  async removeDir(path: string): Promise<void> {
    return this.inner.removeDir(path);
  }
}
