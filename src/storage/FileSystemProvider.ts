import { promises as fs } from "fs";
import * as path from "path";
import { StorageProvider } from "./StorageProvider";

/**
 * FileSystemProvider: ローカルファイルシステム用StorageProvider実装
 */
export class FileSystemProvider implements StorageProvider {
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

  async readFile(filePath: string): Promise<string | Uint8Array> {
    const abs = path.resolve(this.baseDir, filePath);

    return fs.readFile(abs);
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
    const baseDir = this.baseDir;
    const result: string[] = [];
    const walk = async function* (
      pathString: string
    ): AsyncGenerator<string, void, unknown> {
      if ((await fs.stat(pathString)).isFile()) {
        yield pathString;
        return;
      }

      const dirHandle = await fs.opendir(pathString);
      for await (const entry of dirHandle) {
        const full = path.join(pathString, entry.name);
        if (entry.isDirectory()) {
          yield* walk(full);
        } else {
          yield path.relative(baseDir, full);
        }
      }
    };

    for await (const file of walk(abs)) {
      result.push(file);
    }

    return result;
  }
}
