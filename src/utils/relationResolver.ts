import { getAllFieldValues, resolveField } from "./field.js";

/**
 * 配列データから指定パスの値ごとに親オブジェクト配列をMap化する
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
 * Mapのキー部分一致で値を抽出する
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

/**
 * 直接リレーション（hasOne/hasMany等）を解決し、関連オブジェクトを返す
 */
export function resolveDirectRelation(row: any, rel: any, foreignData: any[]): any {
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
    targetData.map((r: any) => [
      resolveField(r, rel.targetForeignKey) ?? "",
      r,
    ])
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
