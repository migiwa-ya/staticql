/**
 * StorageProvider: データソース/出力先のI/O抽象インターフェース
 * - Cloudflare R2/S3/ローカルファイル対応
 * - Workers/Node両対応を想定
 */

export interface StorageProvider {
  /**
   * 指定パス配下のファイル一覧を取得（ワイルドカード/プレフィックス対応）
   * @param pattern 例: "herbs/*.md" または "herbs/"
   */
  listFiles(pattern: string): Promise<string[]>;

  /**
   * ファイルを読み込む
   * @param path
   */
  readFile(path: string): Promise<Uint8Array | string>;

  /**
   * ファイルを書き込む
   * @param path
   * @param data
   */
  writeFile(path: string, data: Uint8Array | string): Promise<void>;

  /**
   * ファイルの存在確認
   * @param path
   */
  exists(path: string): Promise<boolean>;
}
