import { SourceConfigResolver } from "./SourceConfigResolver.js";
import { StaticQL, StaticQLConfig, StaticQLInitOptions } from "./StaticQL.js";
import { FileSystemRepository } from "./repository/FileSystemRepository.js";

/**
 * StaticQL インスタンスを生成するファクトリ関数
 * @param config - StaticQLConfig 設定オブジェクト
 * @returns StaticQL ファクトリー
 */
export function defineStaticQL(config: StaticQLConfig) {
  return ({
    baseDir = "./",
    options = {},
  }: { baseDir?: string; options?: StaticQLInitOptions } = {}) => {
    const repository = new FileSystemRepository(baseDir);
    const sourceConfigResolver = new SourceConfigResolver(config.sources);
    return new StaticQL(config, repository, sourceConfigResolver, options);
  };
}

export type { Validator } from "./validator/Validator.js";
