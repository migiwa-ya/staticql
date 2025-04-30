import { promises as fs } from "fs";
import * as path from "path";
import { StorageProvider } from "./StorageProvider";
import { getSourceIndexFilePath } from "../utils.js";

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
    const result: string[] = [];

    if ((await fs.stat(abs)).isFile()) {
      return [abs];
    }

    for await (const file of this.walk(abs)) {
      result.push(file);
    }

    return result.sort();
  }

  async listFilesByIndex(
    sourceName: string,
    indexDir: string,
    pathString: string
  ): Promise<string[]> {
    const abs = path.resolve(this.baseDir, pathString.replace(/\*.*$/, ""));
    const ext = path.extname(pathString);
    const result: string[] = [];
    const indexFilePath = getSourceIndexFilePath(indexDir, sourceName);

    if ((await fs.stat(abs)).isFile()) {
      return [abs];
    }

    if (!(await this.exists(indexFilePath))) {
      return [];
    }

    const raw = await this.readFile(indexFilePath);
    const fileContent =
      raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;

    const list = JSON.parse(fileContent);

    for (const slug of list) {
      const filePath = path.relative(this.baseDir, path.join(abs, slug)) + ext;

      // -- はディレクトリ階層を示す
      result.push(filePath.replace(/--/g, "/"));
    }

    return result.sort();
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
}
