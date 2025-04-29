import { ContentDB } from "./ContentDB.js";
import type { ContentDBConfig } from "./types.js";
import type { StorageProvider } from "./storage/StorageProvider.js";
import { R2Provider } from "./storage/R2Provider.js";

/**
 * ContentDB インスタンスを生成するファクトリ関数(Cloudflare Workers用)
 * @param config - ContentDBConfig 設定オブジェクト
 * @returns ContentDB インスタンス
 */
export async function defineContentDB(
  config: ContentDBConfig
): Promise<ContentDB> {
  if (config.storage.type !== "r2") {
    throw Error("R2Provider is not available in not `r2` storage type");
  }

  let provider: StorageProvider;
  provider = new R2Provider(config.storage.bucket, config.storage.output);

  return new ContentDB(config, provider);
}
