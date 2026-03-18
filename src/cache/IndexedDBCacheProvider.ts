import { CacheProvider } from "./CacheProvider.js";

const DEFAULT_DB_NAME = "staticql-cache";
const DEFAULT_STORE_NAME = "files";
const VERSION_KEY = "__staticql_version__";

/**
 * IndexedDB-based CacheProvider for browser environments.
 *
 * Caches fetched file contents in IndexedDB so that subsequent
 * accesses skip HTTP requests entirely. Supports cache invalidation
 * via a version string — when the version changes, the entire cache is cleared.
 */
export class IndexedDBCacheProvider implements CacheProvider {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private dbName: string;
  private storeName: string;
  private version?: string;

  /**
   * @param options.version - Build version hash. If it differs from the cached version, the cache is cleared.
   * @param options.dbName - IndexedDB database name. Defaults to "staticql-cache".
   * @param options.storeName - Object store name. Defaults to "files".
   */
  constructor(options: {
    version?: string;
    dbName?: string;
    storeName?: string;
  } = {}) {
    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.storeName = options.storeName ?? DEFAULT_STORE_NAME;
    this.version = options.version;
  }

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };

      request.onsuccess = async () => {
        const db = request.result;

        if (this.version) {
          // Check stored version and clear cache if mismatched
          try {
            const storedVersion = await this.rawGet(db, VERSION_KEY);
            if (storedVersion !== this.version) {
              await this.rawClear(db);
              await this.rawSet(db, VERSION_KEY, this.version);
            }
          } catch {
            await this.rawSet(db, VERSION_KEY, this.version);
          }
        }

        resolve(db);
      };

      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const db = await this.openDB();
    return this.rawGet(db, key);
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    const db = await this.openDB();
    return this.rawSet(db, key, value);
  }

  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== undefined;
  }

  async delete(key: string): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async clear(): Promise<void> {
    const db = await this.openDB();
    return this.rawClear(db);
  }

  private rawGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readonly");
      const store = tx.objectStore(this.storeName);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private rawSet<T>(db: IDBDatabase, key: string, value: T): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private rawClear(db: IDBDatabase): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, "readwrite");
      const store = tx.objectStore(this.storeName);
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}
