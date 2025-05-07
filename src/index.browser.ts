import { StaticQL, StaticQLConfig, StaticQLInitOptions } from "./StaticQL.js";
import { FetchRepository } from "./repository/FetchRepository.js";
import { SourceConfigResolver } from "./SourceConfigResolver.js";

/**
 * StaticQL インスタンスを生成するファクトリ関数
 * @param config - StaticQLConfig 設定オブジェクト
 * @returns StaticQL ファクトリー
 */
export function defineStaticQL(config: StaticQLConfig) {
  return ({
    baseDir = "./",
    options = {},
  }: {
    baseDir?: string;
    options?: StaticQLInitOptions;
  } = {}) => {
    const sourceConfigResolver = new SourceConfigResolver(config.sources);
    const repository = new FetchRepository(baseDir, sourceConfigResolver);
    return new StaticQL(config, repository, sourceConfigResolver, options);
  };
}

export type { StaticQLConfig } from "./StaticQL.js";
export type { Validator } from "./validator/Validator.js";