import { StorageProvider } from "./StorageProvider";

export interface R2Bucket {
  put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<void>;
  get(key: string): Promise<R2ObjectBody | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<R2Objects>;
}

export interface R2ObjectBody {
  body: ReadableStream;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2Objects {
  objects: { key: string }[];
}

export class R2Provider implements StorageProvider {
  constructor(private bucket: R2Bucket, private prefix?: string) {}

  private buildKey(key: string) {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async listFiles(prefix: string): Promise<string[]> {
    const path = prefix.replace(/\*.*$/, "");
    const list = await this.bucket.list({ prefix: path });

    return list.objects.map((obj) => obj.key).sort();
  }

  async listFilesByIndex(
    sourceName: string,
    indexDir: string,
    pathString: string
  ): Promise<string[]> {
    const indexFilePath = `${indexDir}/${sourceName}.index.json`;

    if (!(await this.exists(indexFilePath))) {
      return [];
    }

    const fileContent = await this.readFile(indexFilePath);
    const list = JSON.parse(fileContent) as string[];

    const ext = pathString.includes(".")
      ? pathString.substring(pathString.lastIndexOf("."))
      : "";
    const prefix = pathString.replace(/\*.*$/, "").replace(/\/$/, "");

    const result = list.map((slug) => {
      const filePath = prefix ? `${prefix}/${slug}${ext}` : `${slug}${ext}`;

      // -- はディレクトリ階層を示す
      return filePath.replace(/--/g, "/");
    });

    return result.sort();
  }

  async readFile(path: string): Promise<string> {
    const fullKey = this.buildKey(path);
    const object = await this.bucket.get(fullKey);
    if (!object) return "";

    const body = await object.text();
    return body;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const fullKey = this.buildKey(path);

    await this.bucket.put(fullKey, data);
  }

  async exists(path: string): Promise<boolean> {
    const object = await this.bucket.get(this.buildKey(path));

    return object !== null;
  }

  async delete(key: string) {
    const fullKey = this.buildKey(key);
    await this.bucket.delete(fullKey);
    return { success: true, key: fullKey };
  }
}
