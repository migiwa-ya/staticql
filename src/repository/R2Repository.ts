import { StorageRepository } from "./StorageRepository.js";

/**
 * R2-compatible bucket interface (Cloudflare Workers binding).
 */
export interface R2Bucket {
  put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<void>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<R2Objects>;
}

/**
 * Represents an object retrieved from R2.
 */
export interface R2ObjectBody {
  body: ReadableStream;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Represents the result of listing objects in an R2 bucket.
 */
export interface R2Objects {
  objects: { key: string }[];
}

/**
 * R2Repository: A StorageRepository implementation for Cloudflare R2.
 */
export class R2Repository implements StorageRepository {
  constructor(private bucket: R2Bucket, private prefix?: string) {}

  /**
   * Adds a namespace prefix to keys (if specified).
   */
  private buildKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  /**
   * Lists file paths in the R2 bucket under a given prefix.
   *
   * Supports wildcard patterns by trimming after `*`.
   *
   * @param prefix - Path prefix or glob (e.g. "content/*.md").
   * @returns Sorted list of matching object keys.
   */
  async listFiles(prefix: string): Promise<string[]> {
    const path = prefix.replace(/\*.*$/, "");
    const list = await this.bucket.list({ prefix: path });
    return list.objects.map((obj) => obj.key).sort();
  }

  /**
   * Reads the content of a file from R2.
   *
   * @param path - Key within the bucket.
   * @returns File content as string; empty string if not found.
   */
  async readFile(path: string): Promise<string> {
    const fullKey = this.buildKey(path);
    const object = await this.bucket.get(fullKey);
    if (!object) return "";
    return await object.text();
  }

  /**
   * Opens a file as a ReadableStream from Cloudflare R2.
   *
   * @param path - Key within the bucket.
   * @returns ReadableStream of the file contents.
   * @throws Error if the object does not exist.
   */
  async openFileStream(path: string): Promise<ReadableStream> {
    const fullKey = this.buildKey(path);
    const object = await this.bucket.get(fullKey);
    if (!object || !object.body) {
      throw new Error(`Object not found: ${fullKey}`);
    }
    return object.body;
  }

  /**
   * Writes data to the R2 bucket.
   *
   * @param path - Key to write.
   * @param data - Content to write (string or Uint8Array).
   */
  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const fullKey = this.buildKey(path);
    await this.bucket.put(fullKey, data);
  }

  /**
   * Checks if the specified file exists in the R2 bucket.
   *
   * @param path - Key to check.
   * @returns `true` if it exists, `false` otherwise.
   */
  async exists(path: string): Promise<boolean> {
    const object = await this.bucket.get(this.buildKey(path));
    return object !== null;
  }

  /**
   * Deletes the specified file from the R2 bucket.
   *
   * @param path - Key to delete.
   */
  async removeFile(path: string): Promise<void> {
    const fullKey = this.buildKey(path);
    await this.bucket.delete(fullKey);
  }

  /**
   * Deletes the specified file from the R2 bucket.
   *
   * @param path - Key to delete.
   */
  async removeDir(path: string): Promise<void> {
    const fullKey = this.buildKey(path);
    await this.bucket.delete(fullKey);
  }
}
