/**
 * 分割インデックスファイルのパスを生成
 * @param outputDir - 出力ディレクトリ
 * @param sourceName - ソース名
 * @param field - インデックスフィールド名
 * @param keyValue - キー値
 * @returns 例: output/herbs/index-name/カモミール.json
 */
export function getSplitIndexFilePath(
  outputDir: string,
  sourceName: string,
  field: string,
  keyValue: string
): string {
  return `${getIndexDir(
    outputDir
  )}/${sourceName}/index-${field}/${keyValue}.json`;
}

/**
 * フィールド単位インデックスファイルのパスを生成
 * @param outputDir - 出力ディレクトリ
 * @param sourceName - ソース名
 * @param field - インデックスフィールド名
 * @returns 例: output/herbs.index-name.json
 */
export function getFieldIndexFilePath(
  outputDir: string,
  sourceName: string,
  field: string
): string {
  return `${getIndexDir(outputDir)}/${sourceName}.index-${field}.json`;
}

/**
 * ソース全体インデックスファイルのパスを生成
 * @param outputDir - 出力ディレクトリ
 * @param sourceName - ソース名
 * @returns 例: output/herbs.index.json
 */
export function getSourceIndexFilePath(
  outputDir: string,
  sourceName: string
): string {
  return `${getIndexDir(outputDir)}/${sourceName}.index.json`;
}

export function getIndexDir(outputDir: string): string {
  return `${outputDir}/index`;
}
