import { SourceConfigResolver } from "./SourceConfigResolver.js";
import { StaticQL, StaticQLConfig, StaticQLInitOptions } from "./StaticQL.js";
import { StorageRepository } from "./repository/StorageRepository.js";

/**
 * StaticQL インスタンスを生成するファクトリ関数
 * @param repository - レポジトリクラス
 * @param config - StaticQLConfig 設定オブジェクト
 * @returns StaticQL ファクトリー
 */
export function defineStaticQL(config: StaticQLConfig) {
  return ({
    repository,
    options = {},
  }: {
    repository: StorageRepository;
    options?: StaticQLInitOptions;
  }) => {
    const sourceConfigResolver = new SourceConfigResolver(config.sources);
    return new StaticQL(config, repository, sourceConfigResolver, options);
  };
}

export type { StaticQLConfig } from "./StaticQL.js";
export type { Validator } from "./validator/Validator.js";
export * from "./repository";
