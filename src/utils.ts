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
 * 配列データから指定パスの値ごとに親オブジェクト配列をMap化する
 * @param data - 対象データ配列
 * @param foreignKeyPath - ドット区切りのパス（例: "a.b.c"）
 * @returns Map<値, 親オブジェクト配列>
 */
export function buildForeignKeyMap(
  data: any[],
  foreignKeyPath: string
): Map<string, any[]> {
  const map = new Map<string, any[]>();
  for (const obj of data) {
    const values = getAllFieldValues(obj, foreignKeyPath);
    for (const v of values) {
      if (!map.has(v)) {
        map.set(v, []);
      }
      map.get(v)!.push(obj);
    }
  }
  return map;
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
 * 直接リレーション（hasOne/hasMany等）を解決し、関連オブジェクトを返す
 * @param row - 対象レコード
 * @param rel - リレーション定義（localKey, foreignKey, type等を含む）
 * @param foreignData - 参照先データ配列
 * @returns 関連オブジェクト（hasOneは1件またはnull、hasManyは配列）
 */
export function resolveDirectRelation(
  row: any,
  rel: any,
  foreignData: any[]
): any {
  const foreignMap = buildForeignKeyMap(foreignData, rel.foreignKey);
  const relType = rel.type;
  const localVal = (resolveField(row, rel.localKey) ?? "") as string;
  const keys = localVal.split(" ").filter(Boolean);

  // For each key, get all matching arrays of objects, flatten, and deduplicate
  const matches = keys
    .map((k: string) => findEntriesByPartialKey(foreignMap, k))
    .flat()
    .filter((v: any) => v);

  if (relType === "hasOne") {
    if (matches.length > 0 && Array.isArray(matches[0])) {
      return matches.flat()[0];
    }
    return matches.length > 0 ? matches[0] : null;
  } else if (relType === "hasMany") {
    return matches.flat();
  } else {
    return matches.flat();
  }
}

/**
 * 中間テーブル（through）を介したリレーション（hasOneThrough/hasManyThrough等）を解決
 * @param row - 対象レコード
 * @param rel - リレーション定義（through, throughLocalKey, throughForeignKey, targetForeignKey, type等を含む）
 * @param throughData - 中間テーブルデータ配列
 * @param targetData - 参照先データ配列
 * @returns 関連オブジェクト（hasOneThroughは1件またはnull、hasManyThroughは配列）
 */
export function resolveThroughRelation(
  row: any,
  rel: any,
  throughData: any[],
  targetData: any[]
): any {
  const sourceKey = (resolveField(row, rel.sourceLocalKey) ?? "") as string;
  const throughMatches = throughData.filter((t: any) =>
    ((resolveField(t, rel.throughForeignKey) ?? "") as string)
      .split(" ")
      .includes(sourceKey)
  );
  const targetMap = new Map<string, any>(
    targetData.map((r: any) => [resolveField(r, rel.targetForeignKey) ?? "", r])
  );
  const targets = throughMatches
    .map((t: any) => {
      const throughKey = (resolveField(t, rel.throughLocalKey) ?? "") as string;
      return throughKey
        .split(" ")
        .map((k: string) => targetMap.get(k))
        .filter((v: any) => v);
    })
    .flat();
  if (rel.type === "hasOneThrough") {
    if (targets.length > 0 && Array.isArray(targets[0])) {
      return targets[0];
    }
    return targets.length > 0 ? targets[0] : null;
  } else {
    return targets;
  }
}

/**
 * Mapのキー部分一致で値を抽出する
 * @param map - 検索対象のMap
 * @param keyword - 部分一致させるキーワード
 * @param options - caseInsensitive: 大文字小文字を無視する場合true
 * @returns 部分一致した値の配列
 */
export function findEntriesByPartialKey<K extends string | undefined, V>(
  map: Map<K, V>,
  keyword: string,
  options?: { caseInsensitive?: boolean }
): V[] {
  const matchFn = options?.caseInsensitive
    ? (k: string) => k.toLowerCase().includes(keyword.toLowerCase())
    : (k: string) => k.includes(keyword);

  return Array.from(map.entries())
    .filter(([key]) => key && matchFn(key))
    .map(([, value]) => value);
}
