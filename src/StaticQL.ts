import { SourceLoader } from "./SourceLoader.js";
import { Indexer } from "./Indexer.js";
import { QueryBuilder } from "./QueryBuilder.js";
import {
  SourceConfig,
  SourceConfigResolver,
  SourceRecord,
} from "./SourceConfigResolver.js";
import { StorageRepository } from "./repository/StorageRepository.js";
import { Validator } from "./validator/Validator.js";
import { defaultValidator } from "./validator/defaultValidator.js";
import { ConsoleLogger } from "./logger/ConsoleLogger.js";
import { LoggerProvider } from "./logger/LoggerProvider.js";

export interface StaticQLInitOptions {
  validator?: Validator;
  logger?: LoggerProvider;
}

export interface StaticQLConfig {
  sources: Record<string, SourceConfig>;
}

export class StaticQL {
  private validator: Validator;
  private logger: LoggerProvider;

  constructor(
    private config: StaticQLConfig,
    private repository: StorageRepository,
    private sourceConfigResolver: SourceConfigResolver,
    private options: StaticQLInitOptions = {}
  ) {
    this.validator = this.options.validator ?? defaultValidator;
    this.logger = this.options.logger ?? new ConsoleLogger("info");
  }

  /**
   * 指定sourceの型安全なQueryBuilderを生成する
   * @param sourceName - source名
   * @returns QueryBuilder<T>
   */
  from<T extends SourceRecord>(sourceName: string): QueryBuilder<T> {
    const sourceLoader = new SourceLoader<T>(
      this.repository,
      this.sourceConfigResolver,
      this.validator
    );

    const indexer = new Indexer(
      sourceLoader,
      this.repository,
      this.sourceConfigResolver,
      this.logger
    );

    return new QueryBuilder<T>(
      sourceName,
      sourceLoader,
      indexer,
      this.sourceConfigResolver,
      this.logger
    );
  }

  /**
   * 全sourceのインデックス/メタファイルを config.storage.output ディレクトリに出力する
   * @returns Promise<void>
   * @throws ストレージ書き込み失敗時に例外
   */
  async saveIndexes() {
    await this.getIndexer().save();
  }

  /**
   * 設定情報を返す
   * @returns StaticQLConfig
   */
  getConfig() {
    return this.config;
  }

  /**
   * Indexerインスタンスを返す（インクリメンタルインデックス更新用）
   */
  getIndexer() {
    const sourceLoader = new SourceLoader<SourceRecord>(
      this.repository,
      this.sourceConfigResolver,
      this.validator
    );

    return new Indexer(
      sourceLoader,
      this.repository,
      this.sourceConfigResolver,
      this.logger
    );
  }
}
