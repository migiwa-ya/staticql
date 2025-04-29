import { StaticQL } from "./StaticQL.js";
import type { StaticQLConfig } from "./types.js";
import type { StorageProvider } from "./storage/StorageProvider.js";
import { FileSystemProvider } from "./storage/FileSystemProvider.js";

/**
 * StaticQL インスタンスを生成するファクトリ関数
 * @param config - StaticQLConfig 設定オブジェクト
 * @returns StaticQL ファクトリー
 */
export function defineStaticQL(config: StaticQLConfig) {
  return () => {
    if (config.storage.type === "r2") {
      throw Error("FileSystemProvider is not available in `r2` storage type");
    }

    let provider: StorageProvider;
    provider = new FileSystemProvider(config.storage?.baseDir);

    return new StaticQL(config, provider);
  };
}
