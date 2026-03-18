import { PrefixIndexLine } from "./utils/typs.js";

/**
 * Interface for index reading operations.
 *
 * Decouples IndexBuilder from the concrete PrefixTreeWalker implementation,
 * enabling mock-based testing and alternative implementations (e.g. BundleReader).
 */
export interface IIndexReader {
  findIndexLines(
    sourceName: string,
    field: string,
    value: string,
    filterCallback?: (indexValue: string, argValue: string) => boolean
  ): Promise<null | PrefixIndexLine[]>;

  flatPrefixIndexLine(
    unflattened: PrefixIndexLine[]
  ): PrefixIndexLine[];

  readIndexFileLines(
    indexPath: string,
    reverse: boolean
  ): AsyncGenerator<PrefixIndexLine>;

  readForwardPrefixIndexLines(
    rootDir: string,
    pageSize?: number,
    cursor?: string,
    orderByKey?: string,
    isDesc?: boolean
  ): AsyncGenerator<PrefixIndexLine>;

  readBackwardPrefixIndexLines(
    rootDir: string,
    pageSize?: number,
    cursor?: string,
    orderByKey?: string,
    isDesc?: boolean
  ): AsyncGenerator<PrefixIndexLine>;
}
