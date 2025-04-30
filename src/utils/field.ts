/**
 * 配列で要素数が1の場合は再帰的に中身を取り出す
 * @param value - 任意の値または配列
 * @returns 配列で要素数1なら中身、そうでなければそのまま
 */
export function unwrapSingleArray(value: any) {
  while (Array.isArray(value) && value.length === 1) {
    value = value[0];
  }

  return value;
}

/**
 * オブジェクトからドット記法のパスで値を抽出し、文字列として返す
 * @param obj - 対象オブジェクト
 * @param fieldPath - ドット区切りのパス（例: "a.b.c"）
 * @returns 値が存在すれば文字列、なければ undefined
 */
export function resolveField(obj: any, fieldPath: string): string | undefined {
  const segments = fieldPath.split(".");
  let value: any = obj;

  for (const seg of segments) {
    value = unwrapSingleArray(value);

    if (Array.isArray(value)) {
      value = value.map((v) => v?.[seg]);
    } else {
      value = value?.[seg];
    }

    if (value == null) return undefined;
  }

  if (Array.isArray(value)) {
    return value.filter((v) => v).join(" ");
  }

  return String(value);
}

/**
 * オブジェクトからドット記法のパスで全ての値（配列も含む）を抽出し、文字列配列として返す
 * @param obj - 対象オブジェクト
 * @param fieldPath - ドット区切りのパス（例: "a.b.c"）
 * @returns すべての値を文字列配列で返す（存在しない場合は空配列）
 */
export function getAllFieldValues(obj: any, fieldPath: string): string[] {
  const segments = fieldPath.split(".");
  let values: any[] = [obj];

  for (const seg of segments) {
    values = values
      .map((v) => {
        if (Array.isArray(v)) return v.map((item) => item?.[seg]);
        return v?.[seg];
      })
      .flat()
      .filter((v) => v !== undefined && v !== null);
  }

  // Flatten any nested arrays and stringify primitives
  return values
    .flat(Infinity)
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v));
}

/**
 * オブジェクトまたは配列からネストしたプロパティパスの全値を抽出し、フラットな配列で返す
 * @param objOrArray - 対象オブジェクトまたはオブジェクト配列
 * @param path - プロパティパス配列（例: ['a', 'b']）
 * @returns パス上の全ての値をフラットな配列で返す
 */
export function extractNestedProperty(objOrArray: any, path: string[]): any[] {
  if (!Array.isArray(objOrArray)) objOrArray = [objOrArray];
  let results: any[] = objOrArray;
  for (const key of path) {
    results = results
      .map((item) => {
        if (item == null) return [];
        if (Array.isArray(item)) return item.map((i) => i[key]);
        return item[key];
      })
      .flat();
  }

  // Flatten any nested arrays and remove undefined/null
  return results.flat(Infinity).filter((v) => v !== undefined && v !== null);
}
