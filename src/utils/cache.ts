import { CacheProvider } from "../cache/CacheProvider";

export function cacheAsyncGen<Args extends any[], Key extends string, Value>(
  fn: (...args: Args) => AsyncGenerator<Value>,
  keySelector: (...args: Args) => Key,
  cache: CacheProvider
): (...args: Args) => AsyncGenerator<Value> {
  return async function* (...args: Args) {
    const key = keySelector(...args);

    if (await cache.has(key)) {
      for (const v of await cache.get<any>(key)!) {
        yield v;
      }
    } else {
      const values: Value[] = [];
      for await (const v of fn(...args)) {
        values.push(v);
        yield v;
      }
      cache.set(key, values);
    }
  };
}

export function cacheAsyncFunc<Args extends any[], Key extends string, Value>(
  fn: (...args: Args) => Promise<Value>,
  keySelector: (...args: Args) => Key,
  cache: CacheProvider
): (...args: Args) => Promise<Value | undefined> {
  return async (...args: Args) => {
    const key = keySelector(...args);
    if (await cache.has(key)) {
      return cache.get(key)!;
    } else {
      const value = await fn(...args);
      cache.set(key, value);
      return value;
    }
  };
}
