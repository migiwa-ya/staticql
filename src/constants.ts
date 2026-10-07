import { joinPath } from "./utils/path.js";
import { Relation, ThroughRelation } from "./types.js";
import { PrefixIndexDepth } from "./utils/typs.js";

/** Default prefix for index directories. */
export const INDEX_PREFIX = "index";

/** Default prefix index depth. */
export const DEFAULT_INDEX_DEPTH: PrefixIndexDepth = 1;

/**
 * Returns the path to the prefixes index dir.
 */
export function getIndexDir(sourceName: string, field: string): string {
  return `${INDEX_PREFIX}/${sourceName}.${field}/`;
}

/**
 * Get Prefix Index directories path converted with Unicode.
 */
export function getPrefixIndexPath(value: string, depth: number): string {
  const codes = [...value]
    .slice(0, depth)
    .map((char) => char.charCodeAt(0).toString(16).padStart(4, "0"));

  return joinPath(...codes);
}

/**
 * Determines whether the relation is a through-type.
 */
export function isThroughRelation(rel: Relation): rel is ThroughRelation {
  return (
    typeof rel === "object" &&
    "through" in rel &&
    (rel.type === "hasOneThrough" || rel.type === "hasManyThrough")
  );
}

/**
 * Compare strings by UTF-16 code units, independently of locale.
 */
export function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Match the walker's preorder traversal and its descending reverse. */
export function comparePrefixPath(a: string, b: string, desc: boolean): number {
  const aParts = a.split("/");
  const bParts = b.split("/");
  for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
    const comparison = compareOrdinal(aParts[i], bParts[i]);
    if (comparison) return desc ? -comparison : comparison;
  }
  // Parents precede children in ascending order (#55).
  return desc ? bParts.length - aParts.length : aParts.length - bParts.length;
}

/**
 * Sort PrefixIndexLine comparator factory.
 */
export function indexSort<T>(keys: (keyof T)[] = ["v", "vs"] as (keyof T)[]) {
  return (a: T, b: T) => {
    for (const key of keys) {
      const aVal = a[key];
      const bVal = b[key];
      if (typeof aVal === "string" && typeof bVal === "string") {
        const result = compareOrdinal(aVal, bVal);
        if (result !== 0) return result;
      } else if (aVal !== bVal) {
        return aVal < bVal ? -1 : 1;
      }
    }
    return 0;
  };
}
