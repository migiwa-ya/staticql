import { StaticQL } from "./StaticQL.js";
import type { StaticQLConfig } from "./types.js";
import type { StorageProvider } from "./storage/StorageProvider.js";
import { BrowserStorageProvider } from "./storage/BrowserStorageProvider.js";

/**
 * StaticQL インスタンスを生成するファクトリ関数（ブラウザ用）
 * @param config - StaticQLConfig 設定オブジェクト
 * @returns StaticQL ファクトリー
 */
export function defineStaticQL(config: StaticQLConfig) {
  return () => {
    if (config.storage.type !== "browser") {
      throw Error("BrowserStorageProvider needs `browser` storage type");
    }

    let provider: StorageProvider;
    provider = new BrowserStorageProvider(config.storage?.baseUrl || "/", config);

    return new StaticQL(config, provider);
  };
}
