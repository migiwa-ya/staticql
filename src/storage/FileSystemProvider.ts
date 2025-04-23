import { promises as fs } from "fs";
import { globby } from "globby";
import { StorageProvider } from "./StorageProvider";

/**
 * FileSystemProvider: ローカルファイルシステム用StorageProvider実装
 */
export class FileSystemProvider implements StorageProvider {
  baseDir: string;

  constructor(baseDir: string = ".") {
    this.baseDir = baseDir;
  }

  async listFiles(pattern: string): Promise<string[]> {
    // globbyはbaseDirからの相対パスで検索
    return globby(pattern, { cwd: this.baseDir, onlyFiles: true });
  }

  async readFile(path: string): Promise<Uint8Array | string> {
    const fullPath = `${this.baseDir}/${path}`;
    return fs.readFile(fullPath);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const fullPath = `${this.baseDir}/${path}`;
    // ディレクトリがなければ作成
    await fs.mkdir(fullPath.substring(0, fullPath.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(fullPath, data);
  }

  async exists(path: string): Promise<boolean> {
    const fullPath = `${this.baseDir}/${path}`;
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}
