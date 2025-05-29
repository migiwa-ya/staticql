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

/**
 * Initialization options for StaticQL.
 */
export interface StaticQLInitOptions {
  validator?: Validator;
  logger?: LoggerProvider;
}

/**
 * Configuration for StaticQL.
 */
export interface StaticQLConfig {
  sources: Record<string, SourceConfig>;
}

/**
 * The core class for querying structured static content.
 */
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
   * Creates a type-safe QueryBuilder for the specified source.
   *
   * @param sourceName - Name of the source.
   * @returns A new QueryBuilder instance.
   */
  from<T extends SourceRecord, TIndexKey extends string = keyof {}>(
    sourceName: string
  ): QueryBuilder<T, TIndexKey> {
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

    return new QueryBuilder<T, TIndexKey>(
      sourceName,
      sourceLoader,
      indexer,
      this.sourceConfigResolver,
      this.logger
    );
  }

  /**
   * Saves index files for all sources
   * to the configured output directory.
   *
   * @param customIndexers - Optional custom indexer callbacks for _custom indexes.
   * @throws If writing to the storage fails.
   */
  async saveIndexes(
    customIndexers?: Record<string, (value: any, record?: SourceRecord) => any>
  ): Promise<void> {
    await this.getIndexer(customIndexers).save();
  }

  /**
   * Returns the configuration object used by StaticQL.
   */
  getConfig(): StaticQLConfig {
    return this.config;
  }

  /**
   * Returns an Indexer instance.
   * Useful for incremental index updates.
   */
  getIndexer(
    customIndexers?: Record<string, (value: any, record?: SourceRecord) => any>
  ): Indexer {
    const sourceLoader = new SourceLoader<SourceRecord>(
      this.repository,
      this.sourceConfigResolver,
      this.validator
    );

    return new Indexer(
      sourceLoader,
      this.repository,
      this.sourceConfigResolver,
      this.logger,
      customIndexers
    );
  }
}
