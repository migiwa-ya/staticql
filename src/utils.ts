import { promises as fs } from "fs";
import * as path from "path";

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

// Returns all primitive values at a given path, flattening arrays
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
 * Builds a Map from all possible values at a (possibly array) foreignKey path to an array of their parent objects.
 */
export function buildForeignKeyMap(data: any[], foreignKeyPath: string): Map<string, any[]> {
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
 * Extracts all values at a nested property path from an object or array of objects.
 * Returns a flat array of all values found at the path.
 * Example: extractNestedProperty([{a: {b: 1}}, {a: {b: 2}}], ['a', 'b']) => [1, 2]
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

export function unwrapSingleArray(value: any) {
  while (Array.isArray(value) && value.length === 1) {
    value = value[0];
  }
  return value;
}

/**
 * Resolves a direct relation for a row (hasOne/hasMany).
 * @param row - The source row object
 * @param rel - The relation definition (must have localKey, foreignKey, type)
 * @param foreignData - Array of target objects
 * @returns Related object(s) or null/[]
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
 * Resolves a through relation for a row (hasOneThrough/hasManyThrough).
 * @param row - The source row object
 * @param rel - The relation definition (must have through, throughLocalKey, throughForeignKey, targetForeignKey, type)
 * @param throughData - Array of through objects
 * @param targetData - Array of target objects
 * @returns Related object(s) or null/[]
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
 * 指定ディレクトリがなければ再帰的に作成する
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}
