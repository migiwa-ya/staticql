import { AwsClient } from "aws4fetch";
import { StorageProvider } from "./StorageProvider";

/**
 * S3Provider: Cloudflare R2/S3互換ストレージ用StorageProvider実装（aws4fetchベース）
 * - Cloudflare Workers/Fetch API環境対応
 */
export interface S3ProviderOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3Provider implements StorageProvider {
  private client: AwsClient;
  private endpoint: string;
  private bucket: string;

  constructor(options: S3ProviderOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.bucket = options.bucket;
    this.client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      service: "s3",
      region: "auto", // R2はregion不要
    });
  }

  private objectUrl(key: string): string {
    // R2: https://<accountid>.r2.cloudflarestorage.com/<bucket>/<key>
    return `${this.endpoint}/${this.bucket}/${key}`;
  }

  async listFiles(prefix: string): Promise<string[]> {
    // S3 ListObjectsV2 API
    const url = `${this.endpoint}/${this.bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const res = await this.client.fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`S3 listFiles failed: ${res.status}`);
    const xml = await res.text();
    // 簡易XMLパース（本格運用時はxml2js等推奨）
    const keys: string[] = [];
    const re = /<Key>([^<]+)<\/Key>/g;
    let m;
    while ((m = re.exec(xml))) {
      keys.push(m[1]);
    }
    return keys;
  }

  async readFile(path: string): Promise<Uint8Array | string> {
    const url = this.objectUrl(path);
    const res = await this.client.fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`S3 readFile failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const url = this.objectUrl(path);
    const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const res = await this.client.fetch(url, { method: "PUT", body });
    if (!res.ok) throw new Error(`S3 writeFile failed: ${res.status}`);
  }

  async exists(path: string): Promise<boolean> {
    const url = this.objectUrl(path);
    const res = await this.client.fetch(url, { method: "HEAD" });
    return res.ok;
  }
}
