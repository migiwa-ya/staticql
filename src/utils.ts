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

export function unwrapSingleArray(value: any) {
  while (Array.isArray(value) && value.length === 1) {
    value = value[0];
  }
  return value;
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
