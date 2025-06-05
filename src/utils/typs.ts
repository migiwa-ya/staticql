import { SourceRecord } from "../SourceConfigResolver";

// Extract joinable fields (those referencing SourceRecord or SourceRecord[])
export type JoinableKeys<T> = {
  [K in keyof T]: NonNullable<T[K]> extends SourceRecord | SourceRecord[]
    ? `${Extract<K, string>}`
    : never;
}[keyof T];

// Nest traversal depth limiter
type Prev = [never, 0, 1, 2, 3, 4, 5];

type IsAny<T> = 0 extends 1 & T ? true : false;

// Recursively extract dot-notated nested keys
type NestedIndexKeys<
  T,
  Prefix extends string = "",
  Depth extends number = 3
> = [Depth] extends [never]
  ? never
  : T extends (infer U)[]
  ? NestedIndexKeys<U, Prefix, Depth>
  : T extends object
  ? {
      [K in keyof T]: NonNullable<T[K]> extends { __brand: "index" }
        ? IsAny<T[K]> extends true
          ? never
          : `${Prefix}${Prefix extends "" ? "" : "."}${Extract<K, string>}`
        : NonNullable<T[K]> extends object
        ? NestedIndexKeys<
            NonNullable<T[K]>,
            `${Prefix}${Prefix extends "" ? "" : "."}${Extract<K, string>}`,
            Prev[Depth]
          >
        : never;
    }[keyof T]
  : never;

export type Fields<T> = NestedIndexKeys<T>;

// Directory depth of Prefix Index
export type PrefixIndexDepth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

// Prefix Index Definition for staticql.config.json
export type PrefixIndexDefinition = Record<
  string,
  {
    dir: string;
    depth: PrefixIndexDepth;
  }
>;

// A content of Prefix Index for line (JSON Lines)
export type PrefixIndexLine = {
  v: string;
  vs: string;
  ref: Record<string, Record<"slug" | string, string[]>>;
};

// Un-normalized Prefix Index data
export type RawPrefixIndexLine = {
  slug: string;
  values: Record<string, Record<string, string | string[]>>;
};
