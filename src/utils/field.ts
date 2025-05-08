/**
 * Recursively unwraps a single-element array.
 *
 * @param value - Any value or array.
 * @returns The unwrapped value if the input is a single-element array; otherwise returns the input as-is.
 */
export function unwrapSingleArray(value: any) {
  while (Array.isArray(value) && value.length === 1) {
    value = value[0];
  }
  return value;
}

/**
 * Resolves a dot-notated field path from an object, returning the value as a string.
 *
 * If an intermediate path contains arrays, it will join stringified values with spaces.
 *
 * @param obj - The target object.
 * @param fieldPath - Dot-separated path (e.g., "a.b.c").
 * @returns A string value or `undefined` if the path is invalid.
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
 * Retrieves all values along a dot-notated field path from a given object.
 *
 * Unlike `resolveField`, this always returns a flattened string array of all values found.
 *
 * @param obj - The target object.
 * @param fieldPath - Dot-separated path (e.g., "a.b.c").
 * @returns An array of strings representing all values found; empty if none.
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

  return values
    .flat(Infinity)
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v));
}

/**
 * Extracts all nested property values for a given path from an object or array of objects.
 *
 * Used for recursive property traversal when resolving relations or indexing.
 *
 * @param objOrArray - The input object or array of objects.
 * @param path - An array of property keys (e.g., ['a', 'b']).
 * @returns A flat array of all extracted values along the path.
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

  return results.flat(Infinity).filter((v) => v !== undefined && v !== null);
}
