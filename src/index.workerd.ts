import { StaticQL } from "./StaticQL.js";
import type { StaticQLConfig } from "./types.js";
import type { StorageProvider } from "./storage/StorageProvider.js";
import { R2Provider, R2Bucket } from "./storage/R2Provider.js";

/**
 * StaticQL インスタンスを生成するファクトリ関数(Cloudflare Workers用)
 * @param config - StaticQLConfig 設定オブジェクト
 * @returns StaticQL ファクトリー
 */
export function defineStaticQL(config: StaticQLConfig) {
  return (bucket: R2Bucket) => {
    if (config.storage.type !== "r2") {
      throw Error("R2Provider is not available in not `r2` storage type");
    }

    const provider: StorageProvider = new R2Provider(
      bucket,
      config.storage.output
    );

    return new StaticQL(config, provider);
  };
}
