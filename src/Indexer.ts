import {
  SourceConfigResolver as Resolver,
} from "./SourceConfigResolver.js";
import { SourceRecord } from "./types.js";
import { StorageRepository } from "./repository/StorageRepository.js";
import { SourceLoader } from "./SourceLoader";
import { LoggerProvider } from "./logger/LoggerProvider";
import { PrefixIndexDepth, PrefixIndexLine } from "./utils/typs.js";
import { InMemoryCacheProvider } from "./cache/InMemoryCacheProvider.js";
import { PrefixTreeWalker } from "./PrefixTreeWalker.js";
import { IndexBuilder } from "./IndexBuilder.js";
import { IIndexReader } from "./IIndexReader.js";
import {
  INDEX_PREFIX,
  DEFAULT_INDEX_DEPTH,
  getIndexDir,
  getPrefixIndexPath,
} from "./constants.js";

// Re-export types for backward compatibility
export type { DiffEntry, DirectRelationMap, ThroughRelationMap } from "./types.js";
export type { IIndexReader } from "./IIndexReader.js";

/**
 * Indexer: facade class that composes PrefixTreeWalker and IndexBuilder.
 *
 * Maintains the same public API as before the split for backward compatibility.
 */
export class Indexer {
  public static indexPrefix = INDEX_PREFIX;
  public static indexDepth: PrefixIndexDepth = DEFAULT_INDEX_DEPTH;

  private walker: PrefixTreeWalker;
  private builder: IndexBuilder;

  constructor(
    sourceLoader: SourceLoader<SourceRecord>,
    repository: StorageRepository,
    resolver: Resolver,
    logger: LoggerProvider,
    customIndexers?: Record<string, (value: any, record?: SourceRecord) => any>
  ) {
    const cache = new InMemoryCacheProvider();
    this.walker = new PrefixTreeWalker(repository, resolver, cache);
    this.builder = new IndexBuilder(
      sourceLoader,
      repository,
      resolver,
      logger,
      this.walker,
      customIndexers
    );
  }

  /** Returns the path to the prefixes index dir. */
  static getIndexDir(sourceName: string, field: string): string {
    return getIndexDir(sourceName, field);
  }

  /**
   * Saves indexes and slug lists for all sources.
   */
  async save(): Promise<void> {
    return this.builder.save();
  }

  /**
   * Incrementally updates affected indexes based on diff entries.
   */
  async updateIndexesForFiles(
    diffEntries: import("./types.js").DiffEntry[]
  ): Promise<string[]> {
    return this.builder.updateIndexesForFiles(diffEntries);
  }

  /**
   * Get PrefixIndexLines for next page.
   */
  async *readForwardPrefixIndexLines(
    rootDir: string,
    pageSize: number = 20,
    cursor?: string,
    orderByKey: string = "slug",
    isDesc: boolean = false
  ) {
    yield* this.walker.readForwardPrefixIndexLines(
      rootDir,
      pageSize,
      cursor,
      orderByKey,
      isDesc
    );
  }

  /**
   * Get PrefixIndexLines for backward pagination.
   */
  async *readBackwardPrefixIndexLines(
    rootDir: string,
    pageSize: number = 20,
    cursor?: string,
    orderByKey: string = "slug",
    isDesc: boolean = false
  ) {
    yield* this.walker.readBackwardPrefixIndexLines(
      rootDir,
      pageSize,
      cursor,
      orderByKey,
      isDesc
    );
  }

  /**
   * Read index file lines.
   */
  async *readIndexFileLines(
    indexPath: string,
    reverse: boolean
  ): AsyncGenerator<PrefixIndexLine> {
    yield* this.walker.readIndexFileLines(indexPath, reverse);
  }

  /**
   * Find PrefixIndexLine list with stream.
   */
  async findIndexLines(
    sourceName: string,
    field: string,
    value: string,
    filterCallback?: (indexValue: string, argValue: string) => boolean
  ): Promise<null | PrefixIndexLine[]> {
    return this.walker.findIndexLines(sourceName, field, value, filterCallback);
  }

  /**
   * Flatten PrefixIndexLine array by ref keys.
   */
  flatPrefixIndexLine(unflattened: PrefixIndexLine[]) {
    return this.walker.flatPrefixIndexLine(unflattened);
  }

  /**
   * Get Prefix Index directories path converted with Unicode.
   */
  getPrefixIndexPath(value: string, depth: number): string {
    return getPrefixIndexPath(value, depth);
  }
}
