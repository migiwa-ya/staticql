/**
 * Return as array if not array.
 *
 * @param data
 * @returns array
 */
export function asArray<T>(data: T | T[]): Array<T> {
  if (Array.isArray(data)) return data;

  return [data];
}

/**
 * Map, Set convert to object or array recursive
 *
 * @param value
 * @returns
 */
export function mapSetToObject(value: any): any {
  if (value instanceof Map) {
    const obj: any = {};
    for (const [k, v] of value.entries()) {
      obj[k] = mapSetToObject(v);
    }
    return obj;
  } else if (value instanceof Set) {
    return Array.from(value).map(mapSetToObject);
  } else if (Array.isArray(value)) {
    return value.map(mapSetToObject);
  } else if (typeof value === "object" && value !== null) {
    const obj: any = {};
    for (const key of Object.keys(value)) {
      obj[key] = mapSetToObject(value[key]);
    }
    return obj;
  } else {
    return value;
  }
}

/**
 * Parse _prefixes.jsonl content.
 * 
 * @param raw 
 * @returns 
 */
export function parsePrefixDict(raw: string): string[] {
  return raw
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
}
