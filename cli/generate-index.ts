#!/usr/bin/env node

import path from "path";
import { existsSync, rmSync, readFileSync } from "fs";
import { defineStaticQL } from "../src/index.js";
import { FsRepository } from "../src/repository/FsRepository.js";
import { StaticQL, StaticQLConfig } from "../src/StaticQL.js";
import { DiffEntry, Indexer } from "../src/Indexer.js";
import { ConsoleLogger } from "../src/logger/ConsoleLogger.js";

const logger = new ConsoleLogger("info");

/**
 * Main CLI entry point.
 */
async function run() {
  const { config, outputDir, isIncremental, diffFilePath } = await getArgs();
  const staticql: StaticQL = init(config, outputDir, isIncremental);

  if (isIncremental && diffFilePath) {
    await runIncremental(staticql, diffFilePath);
  } else {
    await runFull(staticql);
  }
}

run();

/**
 * Parses CLI arguments and loads the JSON config file.
 */
function getArgs() {
  const args = process.argv.slice(2);
  let [configPath, outputDir] = args;
  const isIncremental = args.includes("--incremental");
  const diffFilePathArg = args.find((a) => a.startsWith("--diff-file="));
  const diffFilePath = diffFilePathArg ? diffFilePathArg.split("=")[1] : null;

  if (!configPath || !outputDir) {
    console.error(
      "Error: Expected at least 2 arguments: <config_file> <output_dir>"
    );
    process.exit(1);
  }

  configPath = path.resolve(process.cwd(), configPath);

  if (isIncremental && !diffFilePath) {
    console.error(
      "Error: --incremental requires --diff-file=path/to/diff.json"
    );
    process.exit(1);
  }

  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);

  return { config, outputDir, isIncremental, diffFilePath };
}

/**
 * Initializes the StaticQL instance with a file system repository.
 *
 * @param config - Parsed StaticQLConfig object
 * @param outputDir - Output directory for index files
 * @param isIncremental - If true, skip cleanup of existing index files
 * @returns StaticQL instance
 */
function init(
  config: StaticQLConfig,
  outputDir: string,
  isIncremental: boolean
) {
  try {
    const staticql = defineStaticQL(config)({
      repository: new FsRepository(outputDir),
    });

    // Clean up previous indexes if not in incremental mode
    if (!isIncremental) {
      const indexDir = path.resolve(outputDir, Indexer.indexPrefix);
      if (existsSync(indexDir)) {
        rmSync(indexDir, { recursive: true, force: true });
      }
    }

    return staticql;
  } catch (err) {
    console.error("Failed to load StaticQL config.");
    console.error(err);
    process.exit(1);
  }
}

/**
 * Executes full index generation.
 */
async function runFull(staticql: StaticQL) {
  try {
    logger.info("Generating full indexes...");
    await staticql.saveIndexes();
    logger.info("Index generation completed.");
  } catch (err) {
    logger.warn("An error occurred during full index generation.");
    logger.warn(err);
    process.exit(1);
  }
}

/**
 * Executes incremental index updates using a diff file.
 *
 * @param staticql - StaticQL instance
 * @param diffFilePath - Path to diff JSON file
 */
async function runIncremental(staticql: StaticQL, diffFilePath: string) {
  let diffEntries: DiffEntry[];

  try {
    const diffJson = readFileSync(path.resolve(diffFilePath), "utf-8");
    diffEntries = JSON.parse(diffJson);
  } catch (e) {
    logger.warn("Failed to read diff file:", diffFilePath);
    process.exit(1);
  }

  try {
    logger.info("Running incremental index update...");
    await staticql.getIndexer().updateIndexesForFiles(diffEntries);
    logger.info("Incremental index update completed.");
  } catch (err) {
    logger.warn("An error occurred during incremental indexing.");
    logger.warn(err);
    process.exit(1);
  }
}
