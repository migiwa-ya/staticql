import { SourceConfigResolver } from "./SourceConfigResolver.js";
import { registerParser } from "./parser/index.js";
import { StaticQL, StaticQLConfig, StaticQLInitOptions } from "./StaticQL.js";
import { StorageRepository } from "./repository/StorageRepository.js";
import { MultiRepository } from "./repository/MultiRepository.js";

/**
 * Factory function to create a StaticQL instance.
 *
 * @param config - The StaticQL configuration object.
 * @returns A factory function that accepts a repository and optional init options.
 */
export function defineStaticQL(config: StaticQLConfig) {
  return ({
    repository,
    defaultRepository,
    sourceRepositories,
    writeRepository,
    options = {},
  }: {
    repository?: StorageRepository;
    defaultRepository?: StorageRepository;
    sourceRepositories?: Record<string, StorageRepository>;
    writeRepository?: StorageRepository;
    options?: StaticQLInitOptions;
  }) => {
    // inject custom parsers if provided via options
    if (options.parsers) {
      for (const [type, parser] of Object.entries(options.parsers)) {
        registerParser(type, parser);
      }
    }
    const sourceConfigResolver = new SourceConfigResolver(config.sources);

    let repo: StorageRepository;
    if (defaultRepository || sourceRepositories || writeRepository) {
      repo = new MultiRepository(
        defaultRepository ?? repository,
        sourceRepositories,
        writeRepository ?? defaultRepository ?? repository
      );
    } else {
      if (!repository) {
        throw new Error("StaticQL requires a repository instance");
      }
      repo = repository;
    }

    if ("setResolver" in repo && typeof repo.setResolver === "function") {
      repo.setResolver(sourceConfigResolver);
    }

    return new StaticQL(config, repo, sourceConfigResolver, options);
  };
}

// Re-exporting types for convenience
export type { StaticQL, StaticQLConfig } from "./StaticQL.js";
export type { Validator } from "./validator/Validator.js";
export { ConsoleLogger } from "./logger/ConsoleLogger.js";
export type { PageInfo } from "./utils/pagenation.js";
export type { DiffEntry } from "./Indexer.js";
