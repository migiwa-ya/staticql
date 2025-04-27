/**
 * staticql ライブラリのエントリポイント
 * - ContentDB インスタンス生成APIを提供
 * - ストレージ種別（ローカル/S3）に応じて自動的にプロバイダを切り替える
 */
import { ContentDB } from "./ContentDB.js";
import type { ContentDBConfig } from "./types";
import type { StorageProvider } from "./storage/StorageProvider.js";

/**
 * ContentDB インスタンスを生成するファクトリ関数
 * @param config - ContentDBConfig 設定オブジェクト
 * @returns ContentDB インスタンス
 */
export async function defineContentDB(
  config: ContentDBConfig
): Promise<ContentDB> {
  let provider: StorageProvider;

  if (config.storage?.type === "r2") {
    const { R2Provider } = await import("./storage/R2Provider.js");
    provider = new R2Provider(config.storage.bucket, config.storage.output);
  } else {
    const { FileSystemProvider } = await import(
      "./storage/FileSystemProvider.js"
    );
    provider = new FileSystemProvider(config.storage?.baseDir);
  }

  return new ContentDB(config, provider);
}
