import { ContentDB } from "./ContentDB.js";
import type { ContentDBConfig } from "./types.js";
import type { StorageProvider } from "./storage/StorageProvider.js";
import { FileSystemProvider } from "./storage/FileSystemProvider.js";

/**
 * ContentDB インスタンスを生成するファクトリ関数
 * @param config - ContentDBConfig 設定オブジェクト
 * @returns ContentDB インスタンス
 */
export async function defineContentDB(
  config: ContentDBConfig
): Promise<ContentDB> {
  if (config.storage.type === "r2") {
    throw Error("FileSystemProvider is not available in `r2` storage type");
  }

  let provider: StorageProvider;
  provider = new FileSystemProvider(config.storage?.baseDir);

  return new ContentDB(config, provider);
}
