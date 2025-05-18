import { DirectRelationMap, ThroughRelationMap } from "../Indexer.js";
import {
  DirectRelation,
  SourceRecord,
  ThroughRelation,
} from "../SourceConfigResolver.js";
import { resolveField } from "./field.js";

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
  data: SourceRecord[],
  foreignKeyPath: string
): Map<string, SourceRecord[]> {
  const map = new Map<string, any[]>();
  for (const obj of data) {
    const values = resolveField(obj, foreignKeyPath);
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
 * @param foreignMapOpt - (optional) Pre-built foreign key map for performance.
 * @returns Related object(s) or null.
 */
export function resolveDirectRelation(
  row: any,
  rel: DirectRelation,
  foreignData: SourceRecord[],
  foreignMapOpt?: DirectRelationMap["foreignMap"]
): any {
  const foreignMap =
    foreignMapOpt ?? buildForeignKeyMap(foreignData, rel.foreignKey);
  const relType = rel.type;
  const localKeys = resolveField(row, rel.localKey)
    .filter((v): v is string => !!v)
    .flat();

  let matches: any[] = [];
  if (localKeys.length === 1) {
    for (const k of localKeys) {
      const arr = foreignMap.get(k);
      if (arr) matches.push(...arr);
    }
  } else {
    matches = localKeys
      .map((k: string) => findEntriesByPartialKey(foreignMap, k))
      .flat()
      .filter((v: any) => v);
  }

  if (relType === "hasOne") {
    return matches.length > 0 ? matches[0] : null;
  } else {
    return matches;
  }
}

/**
 * Resolves a through-relation (e.g., hasOneThrough, hasManyThrough).
 *
 * @param row - The source object.
 * @param rel - Relation metadata including through and target keys.
 * @param throughData - The intermediate dataset.
 * @param targetData - The final related dataset.
 * @param targetMapOpt - (optional) Pre-built target key map for performance.
 * @returns Related object(s) or null.
 */
export function resolveThroughRelation(
  row: any,
  rel: ThroughRelation,
  throughData: SourceRecord[],
  targetData: SourceRecord[],
  targetMapOpt?: ThroughRelationMap["targetMap"],
  throughMapOpt?: ThroughRelationMap["targetMap"]
): any {
  const sourceKeys = resolveField(row, rel.sourceLocalKey).flat();

  const throughMap: Map<string, SourceRecord[]> =
    throughMapOpt ?? buildForeignKeyMap(throughData, rel.throughForeignKey);

  const targetMap: Map<string, SourceRecord[]> =
    targetMapOpt ?? buildForeignKeyMap(targetData, rel.targetForeignKey);

  const throughRecords: SourceRecord[] = sourceKeys
    .map((k: string) => throughMap.get(k))
    .filter((v: any): v is SourceRecord[] => !!v)
    .filter(Boolean)
    .flat();

  const targets = throughRecords
    .map((t: any) => {
      const throughLocalKeys = resolveField(t, rel.throughLocalKey)
        .filter((v): v is string => !!v)
        .flat();
      return throughLocalKeys
        .map((k: string) => targetMap.get(k))
        .filter((v: any): v is SourceRecord[] => !!v)
        .flat();
    })
    .flat();

  if (rel.type === "hasOneThrough") {
    return targets.length > 0 ? targets[0] : null;
  } else {
    return targets;
  }
}
