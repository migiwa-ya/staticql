import { getAllFieldValues, resolveField } from "./field.js";

/**
 * Builds a map from foreign key values to parent objects.
 *
 * Useful for indexing related records by a specified field.
 *
 * @param data - Array of objects to index.
 * @param foreignKeyPath - Dot-notated path to the key field.
 * @returns A map of key to array of matching objects.
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
 * Finds map entries whose keys partially match a keyword.
 *
 * @param map - A map to search.
 * @param keyword - Keyword to match.
 * @param options - Optional case-insensitive matching.
 * @returns Matching values.
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
 * Resolves a direct relation (e.g., hasOne, hasMany) for a given row.
 *
 * @param row - The source object.
 * @param rel - Relation metadata (including localKey and foreignKey).
 * @param foreignData - The target dataset to match against.
 * @returns Related object(s) or null.
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

  const matches = keys
    .map((k: string) => findEntriesByPartialKey(foreignMap, k))
    .flat()
    .filter((v: any) => v);

  if (relType === "hasOne") {
    return matches.length > 0 ? matches[0] : null;
  } else {
    return matches.flat();
  }
}

/**
 * Resolves a through-relation (e.g., hasOneThrough, hasManyThrough).
 *
 * @param row - The source object.
 * @param rel - Relation metadata including through and target keys.
 * @param throughData - The intermediate dataset.
 * @param targetData - The final related dataset.
 * @returns Related object(s) or null.
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
    return targets.length > 0 ? targets[0] : null;
  } else {
    return targets;
  }
}
