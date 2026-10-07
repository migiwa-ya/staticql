import { CacheProvider } from "../cache/CacheProvider.js";
import { SourceConfigResolver as Resolver } from "../SourceConfigResolver.js";
import type { StorageRepository } from "./StorageRepository.js";

/**
 * CachedRepository: wraps any StorageRepository with a CacheProvider layer.
 *
 * Caches readFile, openFileStream, and exists results so that subsequent
 * accesses for the same path skip the underlying I/O (e.g. HTTP fetch).
 *
 * Reads started after a write or removal completes on this instance reflect
 * the underlying repository. Writes by other instances or browser tabs do
 * not invalidate this instance's cache.
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
  private gen = 0;
  private initialization?: Promise<void>;
  private cachedKeys = new Set<string>();

  constructor(
    private readonly inner: StorageRepository,
    private readonly cache: CacheProvider
  ) {}

  private async ready(): Promise<number> {
    this.initialization ??= (async () => {
      this.gen = (await this.cache.get<number>("meta:gen")) ?? 0;
    })();
    await this.initialization;
    return this.gen;
  }

  private async cacheValue<T>(key: string, value: T, gen: number): Promise<void> {
    await this.cache.set(key, value);
    if (this.gen !== gen) {
      // A read begun before a mutation must not populate the current generation.
      await this.cache.delete(key);
    } else {
      this.cachedKeys.add(key);
    }
  }

  private async invalidate(): Promise<void> {
    const gen = ++this.gen;
    const oldKeys = this.cachedKeys;
    this.cachedKeys = new Set<string>();
    await this.cache.set("meta:gen", gen);
    await Promise.all([...oldKeys].map((key) => this.cache.delete(key)));
  }

  private async mutate(operation: () => Promise<void>): Promise<void> {
    await this.ready();
    try {
      await operation();
    } catch (error) {
      try {
        await this.invalidate();
      } catch {
        // The original repository error takes precedence over cache cleanup.
        // invalidate advances the in-memory generation before any cache I/O.
      }
      throw error;
    }
    await this.invalidate();
  }

  setResolver(resolver: Resolver): void {
    if (this.inner.setResolver) {
      this.inner.setResolver(resolver);
    }
  }

  async readFile(path: string): Promise<string> {
    const gen = await this.ready();
    const cacheKey = `file:${gen}:${path}`;

    const cached = await this.cache.get<string>(cacheKey);
    if (cached !== undefined) return cached;

    const content = await this.inner.readFile(path);
    await this.cacheValue(cacheKey, content, gen);
    return content;
  }

  async openFileStream(path: string): Promise<ReadableStream> {
    const gen = await this.ready();
    const cacheKey = `file:${gen}:${path}`;

    const cached = await this.cache.get<string>(cacheKey);
    let content: string;
    if (cached !== undefined) {
      content = cached;
    } else {
      content = await this.inner.readFile(path);
      await this.cacheValue(cacheKey, content, gen);
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
    const gen = await this.ready();
    const cacheKey = `file:${gen}:${path}`;

    // If content is already cached, we know it exists
    if (await this.cache.has(cacheKey)) {
      return true;
    }

    return this.inner.exists(path);
  }

  async listFiles(pattern: string): Promise<string[]> {
    const gen = await this.ready();
    const cacheKey = `list:${gen}:${pattern}`;

    const cached = await this.cache.get<string[]>(cacheKey);
    if (cached !== undefined) return cached;

    const files = await this.inner.listFiles(pattern);
    await this.cacheValue(cacheKey, files, gen);
    return files;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    return this.mutate(() => this.inner.writeFile(path, data));
  }

  async removeFile(path: string): Promise<void> {
    return this.mutate(() => this.inner.removeFile(path));
  }

  async removeDir(path: string): Promise<void> {
    return this.mutate(() => this.inner.removeDir(path));
  }
}
