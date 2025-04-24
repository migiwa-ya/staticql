/**
 * staticql ライブラリのエントリポイント
 * - ContentDB インスタンス生成APIを提供
 * - ストレージ種別（ローカル/S3）に応じて自動的にプロバイダを切り替える
 */
import { ContentDB } from "./ContentDB.js";
import type { ContentDBConfig } from "./types";
import { FileSystemProvider } from "./storage/FileSystemProvider.js";
import { S3Provider } from "./storage/S3Provider.js";
import type { StorageProvider } from "./storage/StorageProvider.js";

/**
 * ContentDB インスタンスを生成するファクトリ関数
 * @param config - ContentDBConfig 設定オブジェクト
 * @returns ContentDB インスタンス
 * @description
 *   config.storage.type が "s3" の場合は S3Provider、
 *   それ以外は FileSystemProvider（ローカル）を利用
 */
export function defineContentDB(config: ContentDBConfig): ContentDB {
  let provider: StorageProvider;

  if (config.storage?.type === "s3") {
    provider = new S3Provider(config.storage);
  } else {
    provider = new FileSystemProvider(config.storage?.baseDir);
  }

  return new ContentDB(config, provider);
}
