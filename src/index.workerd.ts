import { SourceConfigResolver } from "./SourceConfigResolver.js";
import { StaticQL, StaticQLConfig, StaticQLInitOptions } from "./StaticQL.js";
import { R2Bucket, R2Repository } from "./repository/R2Repository.js";

/**
 * StaticQL インスタンスを生成するファクトリ関数
 * @param config - StaticQLConfig 設定オブジェクト
 * @returns StaticQL ファクトリー
 */
export function defineStaticQL(config: StaticQLConfig) {
  return ({
    bucket,
    options = {},
  }: {
    bucket: R2Bucket;
    options?: StaticQLInitOptions;
  }) => {
    const repository = new R2Repository(bucket);
    const sourceConfigResolver = new SourceConfigResolver(config.sources);
    return new StaticQL(config, repository, sourceConfigResolver, options);
  };
}

export type { Validator } from "./validator/Validator.js";
