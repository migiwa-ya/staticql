/**
 * StorageRepository: データソース/出力先のI/O抽象インターフェース
 */
export interface StorageRepository {
  /**
   * 指定パスまたはその配下のファイル一覧を取得（ワイルドカード/プレフィックス対応）
   * @param pattern 例: "herbs/*.md", "report/", "herbParts.yaml"
   */
  listFiles(pattern: string): Promise<string[]>;

  /**
   * ファイルを読み込む
   * @param path
   */
  readFile(path: string): Promise<string>;

  /**
   * ファイルを書き込む
   * @param path
   * @param data
   */
  writeFile(path: string, data: Uint8Array | string): Promise<void>;

  /**
   * ファイルを削除する
   * @param path
   * @param data
   */
  removeFile(path: string): Promise<void>;

  /**
   * ファイルの存在確認
   * @param path
   */
  exists(path: string): Promise<boolean>;
}
