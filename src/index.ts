import { SourceConfigResolver } from "./SourceConfigResolver.js";
import { StaticQL, StaticQLConfig, StaticQLInitOptions } from "./StaticQL.js";
import { StorageRepository } from "./repository/StorageRepository.js";

/**
 * Factory function to create a StaticQL instance.
 *
 * @param config - The StaticQL configuration object.
 * @returns A factory function that accepts a repository and optional init options.
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

    // Set to a repository that needs RSC
    if (
      "setResolver" in repository &&
      typeof repository.setResolver === "function"
    ) {
      repository.setResolver(sourceConfigResolver);
    }

    return new StaticQL(config, repository, sourceConfigResolver, options);
  };
}

// Re-exporting types for convenience
export type { StaticQLConfig } from "./StaticQL.js";
export type { Validator } from "./validator/Validator.js";
export { ConsoleLogger } from "./logger/ConsoleLogger.js";
export type { PageInfo } from "./utils/pagenation.js";
