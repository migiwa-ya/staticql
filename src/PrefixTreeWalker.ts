import { StorageRepository } from "./repository/StorageRepository.js";
import {
  SourceConfigResolver as Resolver,
} from "./SourceConfigResolver.js";
import { joinPath, tail, toI, toP, trimSlash } from "./utils/path.js";
import { readJsonlStream, readListStream } from "./utils/stream.js";
import { PrefixIndexLine } from "./utils/typs.js";
import { decodeCursor } from "./utils/pagenation.js";
import { cacheAsyncGen } from "./utils/cache.js";
import { CacheProvider } from "./cache/CacheProvider.js";
import { getPrefixIndexPath } from "./constants.js";
import { IIndexReader } from "./IIndexReader.js";
import { isNotFoundError } from "./repository/errors.js";

/**
 * PrefixTreeWalker: handles prefix tree traversal and index reading.
 */
export class PrefixTreeWalker implements IIndexReader {
  constructor(
    private readonly repository: StorageRepository,
    private readonly resolver: Resolver,
    private readonly cache: CacheProvider
  ) {}

  private walkCacheKey(direction: "down" | "up", rootDir: string, startDir: string) {
    return `walk:${direction}:${trimSlash(rootDir)}:${trimSlash(startDir)}`;
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
    const cursorObject = cursor ? decodeCursor(cursor) : undefined;
    const indexParentDir = cursorObject
      ? joinPath(rootDir, cursorObject.order[orderByKey])
      : isDesc
      ? tail(await this.findLastIndexPath(rootDir)).base
      : tail(await this.findFirstIndexPath(rootDir)).base;

    const targetSlug = cursorObject?.slug;
    let count = 0;
    let countable = !targetSlug;

    const indexWalker = isDesc
      ? this.walkPrefixIndexesUpword
      : this.walkPrefixIndexesDownword;

    const gen = cacheAsyncGen(
      (path: string) => indexWalker.bind(this)(path, rootDir),
      (path) => this.walkCacheKey(isDesc ? "up" : "down", rootDir, path),
      this.cache
    );

    const reverseInFile = isDesc;

    for await (const indexPath of gen(indexParentDir)) {
      for await (const prefixIndexLine of this.readIndexFileLines(
        indexPath,
        reverseInFile
      )) {
        if (!countable && targetSlug) {
          if (
            Object.prototype.hasOwnProperty.call(
              prefixIndexLine.ref,
              targetSlug
            )
          ) {
            countable = true;
            continue;
          }
        }
        if (countable) {
          yield prefixIndexLine;
          if (++count >= pageSize) return;
        }
      }
    }
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
    const cursorObject = cursor ? decodeCursor(cursor) : undefined;
    const indexParentDir = cursorObject
      ? joinPath(rootDir, cursorObject.order[orderByKey])
      : isDesc
      ? tail(await this.findFirstIndexPath(rootDir)).base
      : tail(await this.findLastIndexPath(rootDir)).base;

    const targetSlug = cursorObject?.slug;
    let count = 0;
    let countable = !targetSlug;

    const indexWalker = isDesc
      ? this.walkPrefixIndexesDownword
      : this.walkPrefixIndexesUpword;

    const gen = cacheAsyncGen(
      (path: string) => indexWalker.bind(this)(path, rootDir),
      (path) => this.walkCacheKey(isDesc ? "down" : "up", rootDir, path),
      this.cache
    );

    const reverseInFile = !isDesc;

    for await (const indexPath of gen(indexParentDir)) {
      for await (const prefixIndexLine of this.readIndexFileLines(
        indexPath,
        reverseInFile
      )) {
        if (!countable && targetSlug) {
          if (
            Object.prototype.hasOwnProperty.call(
              prefixIndexLine.ref,
              targetSlug
            )
          ) {
            countable = true;
            continue;
          }
        }
        if (countable) {
          yield prefixIndexLine;
          if (++count >= pageSize) return;
        }
      }
    }
  }

  /**
   * Read index file lines.
   */
  async *readIndexFileLines(
    indexPath: string,
    reverse: boolean
  ): AsyncGenerator<PrefixIndexLine> {
    let stream: ReadableStream;
    try {
      stream = await this.repository.openFileStream(indexPath);
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw error;
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    if (reverse) {
      // index contents are fixed in ascending order,
      // so they need to be collected once and put in descending order
      const buf: PrefixIndexLine[] = [];
      for await (const line of readJsonlStream<PrefixIndexLine>(
        reader,
        decoder
      )) {
        buf.push(line);
      }
      yield* buf.reverse();
    } else {
      yield* readJsonlStream<PrefixIndexLine>(reader, decoder);
    }
  }

  /**
   * Find PrefixIndexLine list with stream.
   */
  async findIndexLines(
    sourceName: string,
    field: string,
    value: string,
    filterCallback = (indexValue: string, argValue: string) =>
      indexValue === argValue
  ): Promise<null | PrefixIndexLine[]> {
    const rsc = this.resolver.resolveOne(sourceName);
    if (!rsc.indexes) return null;

    let indexPath = this.getIndexPath(sourceName, field, value);
    if (indexPath && rsc.indexes[field].depth > value.length) {
      indexPath = await this.findFirstIndexPath(tail(indexPath).base);
    }
    if (!indexPath) return null;

    // Skip the exists() pre-check (saves a HEAD request).
    // The walker's stream open attempt will handle non-existent paths via try-catch.
    const repository = this.repository;

    const indexWalker = this.walkPrefixIndexesDownword;
    const rootDir = rsc.indexes[field].dir;

    const gen = cacheAsyncGen(
      (path: string) => indexWalker.bind(this)(path, rootDir),
      (path) => this.walkCacheKey("down", rootDir, path),
      this.cache
    );

    const result: Set<PrefixIndexLine> = new Set();

    let found: boolean | null = null;

    finder: for await (const indexPathEntry of gen(tail(indexPath).base)) {
      let stream: ReadableStream;
      try {
        stream = await repository.openFileStream(indexPathEntry);
      } catch (error) {
        if (isNotFoundError(error)) break finder;
        throw error;
      }
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      for await (const entry of readJsonlStream<PrefixIndexLine>(reader, decoder)) {
        if (filterCallback(entry.v, value)) {
          result.add(entry);
          found = true;
        } else if (found === true) {
          found = false;
        }
        if (found === false) {
          await reader.cancel();
          break finder;
        }
      }

      // if result is empty before walk next index, no there more
      if (!result.size) break;
    }

    return this.flatPrefixIndexLine([...result]);
  }

  /**
   * Read exact values from their unique file, including short parent prefixes.
   */
  async findExactIndexLines(
    sourceName: string,
    field: string,
    value: string
  ): Promise<PrefixIndexLine[]> {
    const indexPath = this.getIndexPath(sourceName, field, value);
    // exists returns false only for confirmed absence; other failures reject.
    if (!indexPath || !(await this.repository.exists(indexPath))) return [];

    const matched: PrefixIndexLine[] = [];
    for await (const line of this.readIndexFileLines(indexPath, false)) {
      if (line.v === value) matched.push(line);
    }
    return this.flatPrefixIndexLine(matched);
  }

  /**
   * Flatten PrefixIndexLine array by ref keys.
   */
  flatPrefixIndexLine(unflattened: PrefixIndexLine[]) {
    const seen = new Set<string>();
    const flattened: PrefixIndexLine[] = [];

    for (const item of unflattened) {
      for (const [key, value] of Object.entries(item.ref)) {
        if (!seen.has(key)) {
          seen.add(key);
          flattened.push({
            v: item.v,
            vs: item.vs,
            ref: { [key]: value },
          });
        }
      }
    }

    return flattened;
  }

  /**
   * Get the first index of the specified directory.
   */
  private async findFirstIndexPath(dir: string): Promise<string> {
    if (await this.repository.exists(toI(dir))) return toI(dir);
    const prefixIndexPath = toP(dir);
    let prefix: string;

    let stream: ReadableStream;
    try {
      stream = await this.repository.openFileStream(prefixIndexPath);

      const reader = stream.getReader();
      const decoder = new TextDecoder();

      const { value, done } = await readListStream(reader, decoder).next();
      if (done) return toI(dir);
      prefix = value;
    } catch (error) {
      if (isNotFoundError(error)) return toI(dir);
      throw error;
    }

    return this.findFirstIndexPath(joinPath(dir, prefix));
  }

  /**
   * Get the index of the deepest level below the specified directory.
   */
  private async findLastIndexPath(dir: string): Promise<string> {
    const prefixIndexPath = toP(dir);
    let prefix: string | undefined;

    let stream: ReadableStream;
    try {
      stream = await this.repository.openFileStream(prefixIndexPath);

      const reader = stream.getReader();
      const decoder = new TextDecoder();

      for await (prefix of readListStream(reader, decoder));
    } catch (error) {
      if (isNotFoundError(error)) return toI(dir);
      throw error;
    }

    if (prefix === undefined) return toI(dir);
    return this.findLastIndexPath(joinPath(dir, prefix));
  }

  /**
   * Indexes are scanned downward from the specified index directory.
   */
  async *walkPrefixIndexesDownword(
    indexParentDir: string,
    rootDir: string
  ): AsyncGenerator<string> {
    const repository = this.repository;
    const readPrefixes = async function* (dir: string): AsyncGenerator<string> {
      let stream: ReadableStream;
      try {
        stream = await repository.openFileStream(toP(dir));
      } catch (error) {
        if (isNotFoundError(error)) return;
        throw error;
      }
      yield* readListStream(stream.getReader(), new TextDecoder());
    };

    const subtree = async function* (dir: string): AsyncGenerator<string> {
      if (await repository.exists(toI(dir))) yield toI(dir);
      for await (const prefix of readPrefixes(dir)) {
        yield* subtree(joinPath(dir, prefix));
      }
    };

    let dir = trimSlash(indexParentDir);
    const root = trimSlash(rootDir);
    yield* subtree(dir);
    while (dir !== root) {
      const { base: parent, tail: child } = tail(dir);
      let afterChild = false;
      for await (const prefix of readPrefixes(parent)) {
        if (afterChild) yield* subtree(joinPath(parent, prefix));
        if (prefix === child) afterChild = true;
      }
      dir = parent;
    }
  }

  /**
   * Indexes are scanned upward from the specified index directory.
   */
  async *walkPrefixIndexesUpword(indexParentDir: string, rootDir: string) {
    const repository = this.repository;

    // if a path to an index is specified for the first time,
    // disable access to indexes located before it.
    let visitable = false;

    const walk = async function* (
      dir: string,
      visited: Set<string> = new Set()
    ): AsyncGenerator<string> {
      if (!visited.has(toP(dir))) {
        try {
          const stream = await repository.openFileStream(toP(dir));
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          const buff: Set<string> = new Set();

          visited.add(toP(dir));
          visited.add(dir);

          for await (const prefix of readListStream(reader, decoder)) {
            buff.add(prefix);
          }

          for (const prefix of [...buff].reverse()) {
            if (!visitable && visited.has(joinPath(dir, prefix))) {
              visitable = true;
            }

            if (visitable) {
              yield* walk(joinPath(dir, prefix), visited);
            }
          }
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
          // record visits that include index directories
          visited.add(dir);
        }
      }

      if (!visited.has(toI(dir))) {
        if (await repository.exists(toI(dir))) {
          yield toI(dir);
          visited.add(toI(dir));
        }
        visited.add(dir);
      }

      if (trimSlash(dir) !== trimSlash(rootDir) && !visited.has(tail(dir).base)) {
        // reset when ascending a hierarchy to enable skipping in that hierarchy
        visitable = false;

        yield* walk(tail(dir).base, visited);
      }
    };

    yield* walk(trimSlash(indexParentDir), new Set());
  }

  /**
   * Get Prefix Index file path converted with Unicode.
   */
  private getIndexPath(sourceName: string, field: string, value: string) {
    const rsc = this.resolver.resolveOne(sourceName);
    if (!rsc.indexes) return null;

    const config = rsc.indexes[field];
    const prefix = getPrefixIndexPath(value, config.depth);
    const indexPath = toI(config.dir, prefix);

    return indexPath;
  }
}
