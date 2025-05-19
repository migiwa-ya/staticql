import { CacheProvider } from "./CacheProvider";

export class InMemoryCacheProvider implements CacheProvider {
  private cache = new Map<string, any>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.cache.get(key);
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    this.cache.set(key, value);
  }

  async has(key: string): Promise<boolean> {
    return this.cache.has(key);
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }
}
