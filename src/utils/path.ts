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
  const indexDirIdentifier = "index";

  return `${outputDir}/${indexDirIdentifier}`;
}

/**
 * globパターンからワイルドカードより前のディレクトリ部分を抽出
 * @param globPath - globを含むパス
 * @returns ディレクトリパス
 */
export function extractBaseDir(globPath: string): string {
  const parts = globPath.split("/");
  const index = parts.findIndex((part) => part.includes("*"));

  if (index === -1) return globPath;
  return parts.slice(0, index).join("/") + "/";
}

/**
 * ファイルパスからslug（論理ID）を生成
 * @param sourcePath - 設定で定義されたsourceのパス（glob含む）
 * @param filePath - 実際のファイルパス
 * @returns slug文字列
 */
export function getSlugFromPath(sourcePath: string, filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")) || "";
  const baseDir = extractBaseDir(sourcePath);
  let rel = filePath.startsWith(baseDir)
    ? filePath.slice(baseDir.length)
    : filePath;
  if (rel.startsWith("/")) rel = rel.slice(1);

  const slug = pathToSlug(rel.replace(ext, ""));

  return slug;
}

/**
 * sourceGlob, relativePathから論理パスを生成
 * @param sourceGlob - globを含むパス
 * @param relativePath - 相対パス
 * @returns 論理パス
 */
export function resolveFilePath(
  sourceGlob: string,
  relativePath: string
): string {
  const baseDir = extractBaseDir(sourceGlob);

  return baseDir + relativePath;
}

/**
 * slug（--区切り）をパス（/区切り）に変換
 * @param slug
 * @returns パス文字列
 */
export function slugToPath(slug: string): string {
  return slug.replace(/--/g, "/");
}

/**
 * パス（/区切り）をslug（--区切り）に変換
 * @param path
 * @returns パス文字列
 */
export function pathToSlug(path: string): string {
  return path.replace(/\//g, "--");
}

export function slugsToFilePaths(
  pattern: string,
  slugs: string[],
  ext?: string
): string[] {
  // pattern の拡張子
  if (!ext) {
    const extMatch = pattern.match(/\.(\w+)$/);
    ext = extMatch ? "." + extMatch[1] : "";
  }

  // slugフィルタ: patternをslugの--区切りに対応した正規表現に変換
  let filteredSlugs = slugs;
  if (pattern.includes("*")) {
    const wcIdx = pattern.indexOf("*");
    let slugPattern = pattern.slice(wcIdx);
    slugPattern = pathToSlug(slugPattern);
    slugPattern = slugPattern.replace(/\.[^\.]+$/, "");
    slugPattern = slugPattern
      .replace(/\*\*/g, "([\\w-]+(--)?)*")
      .replace(/\*/g, "[\\w-]+");
    const regex = new RegExp("^" + slugPattern + "$");
    filteredSlugs = slugs.filter((slug) => regex.test(slug));
  }

  // slug→パス変換
  return filteredSlugs.map((slug) =>
    resolveFilePath(pattern, slugToPath(slug) + ext)
  );
}
