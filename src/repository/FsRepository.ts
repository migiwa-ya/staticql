import { promises as fs } from "fs";
import * as path from "path";
import { StorageRepository } from "./StorageRepository";

/**
 * FSProvider: ローカルファイルシステム用StorageProvider実装
 */
export class FsRepository implements StorageRepository {
  baseDir: string;

  constructor(baseDir: string = ".") {
    this.baseDir = baseDir;
  }

  /**
   * ファイルまたはディレクトリの存在確認
   * @param filePath - 相対パス
   * @returns 存在すればtrue、なければfalse
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

  async readFile(filePath: string): Promise<string> {
    const abs = path.resolve(this.baseDir, filePath);

    return await fs.readFile(abs, "utf-8");
  }

  async writeFile(
    filePath: string,
    content: string | Uint8Array
  ): Promise<void> {
    const abs = path.resolve(this.baseDir, filePath);

    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  /**
   * 指定されたパスまたはglobからファイル一覧を取得
   * @param pathString - パスまたはglob
   * @returns ファイルパス配列
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
   * 指定ファイルを削除
   * @param filePath - 相対パス
   */
  async removeFile(filePath: string): Promise<void> {
    const abs = path.resolve(this.baseDir, filePath);

    await fs.unlink(abs);
  }
}
