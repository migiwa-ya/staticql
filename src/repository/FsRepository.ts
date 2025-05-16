import { promises as fs } from "fs";
import { createReadStream } from "node:fs";
import * as path from "path";
import { StorageRepository } from "./StorageRepository";
import { Readable } from "node:stream";

/**
 * FsRepository: StorageRepository implementation for the local file system.
 */
export class FsRepository implements StorageRepository {
  baseDir: string;

  constructor(baseDir: string = ".") {
    this.baseDir = baseDir;
  }

  /**
   * Checks whether a file or directory exists.
   *
   * @param filePath - Relative path from baseDir.
   * @returns `true` if the file exists, otherwise `false`.
   */
  async exists(filePath: string): Promise<boolean> {
    const abs = path.resolve(this.baseDir, filePath);

    try {
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reads the content of a file as UTF-8 text.
   *
   * @param filePath - Relative path to the file.
   * @returns File content as a string.
   */
  async readFile(filePath: string): Promise<string> {
    const abs = path.resolve(this.baseDir, filePath);
    return await fs.readFile(abs, "utf-8");
  }

  /*
   * Opens a file as a ReadableStream.
   *
   * @param path - Relative path to the file (from the repository base directory)
   * @returns Promise that resolves to a ReadableStream for the file contents
   */
  async openFileStream(path: string): Promise<ReadableStream> {
    const fullPath = [this.baseDir, path].join("/");
    const stream = createReadStream(fullPath);
    return Readable.toWeb(stream) as ReadableStream;
  }

  /**
   * Writes data to a file (string or binary). Creates parent directories if needed.
   *
   * @param filePath - Relative file path.
   * @param content - File content as string or Uint8Array.
   */
  async writeFile(
    filePath: string,
    content: string | Uint8Array
  ): Promise<void> {
    const abs = path.resolve(this.baseDir, filePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  /**
   * Lists all files under a given path or glob pattern.
   *
   * If the path points to a file, it returns an array with a single entry.
   * Otherwise, recursively walks the directory and returns all file paths.
   *
   * @param pathString - Path or glob pattern (e.g. "data/*.json").
   * @returns List of relative file paths.
   */
  async listFiles(pathString: string): Promise<string[]> {
    const abs = path.resolve(this.baseDir, pathString.replace(/\*.*$/, ""));
    const result: string[] = [];

    if ((await fs.stat(abs)).isFile()) {
      return [abs];
    }

    for await (const file of this.walk(abs)) {
      result.push(file);
    }

    return result;
  }

  /**
   * Recursively walks through a directory and yields all file paths.
   *
   * @param pathString - Absolute path to start from.
   * @yields Relative file paths from baseDir.
   */
  async *walk(pathString: string): AsyncGenerator<string, void, unknown> {
    const dirHandle = await fs.opendir(pathString);

    for await (const entry of dirHandle) {
      const full = path.join(pathString, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(full);
      } else {
        yield path.relative(this.baseDir, full);
      }
    }
  }

  /**
   * Deletes the specified file.
   *
   * @param filePath - Relative path to the file.
   */
  async removeFile(filePath: string): Promise<void> {
    const abs = path.resolve(this.baseDir, filePath);
    await fs.unlink(abs);
  }

  /**
   * Deletes the directory recursive.
   *
   * @param filePath - Relative path to the file.
   */
  async removeDir(filePath: string): Promise<void> {
    const abs = path.resolve(this.baseDir, filePath);
    if (!(await this.exists(abs))) return;
    await fs.rm(abs, { recursive: true });
  }
}
