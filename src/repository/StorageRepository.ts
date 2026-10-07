import { SourceConfigResolver as Resolver } from "../SourceConfigResolver.js";

/**
 * StorageRepository: Abstract interface for reading and writing data sources.
 *
 * This defines the I/O contract used by StaticQL to interact with
 * various storage backends (e.g., local FS, R2, GitHub, etc.).
 */
export interface StorageRepository {
  /**
   * Lists files matching a glob pattern or prefix.
   *
   * @param pattern - Path pattern (e.g., "herbs/*.md", "report/", "herbParts.yaml").
   * @returns An array of matched file paths.
   */
  listFiles(pattern: string): Promise<string[]>;

  /**
   * Reads the content of a file.
   * Reject with NotFoundError for confirmed absence; reject other failures
   * without converting them to absence. Index queries propagate those failures.
   * Empty index content means no entries. For source-loading compatibility,
   * the built-in R2Repository.readFile returns "" for an absent object.
   *
   * @param path - The file path to read.
   * @returns File content as a UTF-8 string.
   */
  readFile(path: string): Promise<string>;

  /**
   * Opens a file as a web-compatible ReadableStream.
   * Reject with NotFoundError only for confirmed absence. Other open/read
   * failures must propagate to the index query. Empty content means no entries.
   *
   * @param path - Relative path to the file (from the repository base directory)
   * @returns Promise that resolves to a ReadableStream for the file contents
   */
  openFileStream(path: string): Promise<ReadableStream>;

  /**
   * Writes data to a file.
   *
   * @param path - Destination file path.
   * @param data - File contents as a string or binary buffer.
   */
  writeFile(path: string, data: Uint8Array | string): Promise<void>;

  /**
   * Removes a file.
   *
   * @param path - The file path to delete.
   */
  removeFile(path: string): Promise<void>;

  removeDir(path: string): Promise<void>;

  /**
   * Checks if a file exists.
   *
   * @param path - The file path to check.
   * @returns `true` if the file exists, `false` only for confirmed absence.
   * @throws If existence cannot be determined (e.g. permission/network failure).
   */
  exists(path: string): Promise<boolean>;

  /**
   * A setter for accessing SourceConfigResolver within the class.
   * It is set internally during the initialization of the index.ts.
   *
   * @param resolver
   */
  setResolver?(resolver: Resolver): void;
}
