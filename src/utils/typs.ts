import { SourceRecord } from "../SourceConfigResolver";

// Extract joinable fields (those referencing SourceRecord or SourceRecord[])
export type JoinableKeys<T> = {
  [K in keyof T]: NonNullable<T[K]> extends SourceRecord | SourceRecord[]
    ? `${Extract<K, string>}`
    : never;
}[keyof T];

// Nest traversal depth limiter
type Prev = [never, 0, 1, 2, 3, 4, 5];

// Recursively extract dot-notated nested keys
export type NestedKeys<
  T,
  Prefix extends string = "",
  Depth extends number = 3
> = [Depth] extends [never]
  ? never
  : T extends object
  ? {
      [K in keyof T]: NonNullable<T[K]> extends object
        ? NestedKeys<
            NonNullable<T[K]>,
            `${Prefix}${Prefix extends "" ? "" : "."}${Extract<K, string>}`,
            Prev[Depth]
          >
        : `${Prefix}${Prefix extends "" ? "" : "."}${Extract<K, string>}`;
    }[keyof T]
  : never;

// Extract queryable fields (excluding relations)
export type SourceFields<T> = {
  [K in keyof T]: NonNullable<T[K]> extends SourceRecord | SourceRecord[]
    ? never
    : NonNullable<T[K]> extends (infer U)[]
    ? U extends object
      ? NestedKeys<U, Extract<K, string>>
      : K
    : NonNullable<T[K]> extends object
    ? NestedKeys<NonNullable<T[K]>, Extract<K, string>>
    : K;
}[keyof T];

// Extract fields from relational records
export type RelationalFields<T> = {
  [K in keyof T]: NonNullable<T[K]> extends SourceRecord | SourceRecord[]
    ? NonNullable<T[K]> extends (infer U)[]
      ? U extends object
        ? NestedKeys<U, Extract<K, string>>
        : never
      : NonNullable<T[K]> extends object
      ? NestedKeys<NonNullable<T[K]>, Extract<K, string>>
      : never
    : K;
}[keyof T];

// All queryable fields
export type Fields<T> = RelationalFields<T> | SourceFields<T>;

// Directory depth of Prefix Index 
export type PrefixIndexDepth = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

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
  r: Record<string, Record<"slug" | string, string[]>>;
};

// Un-normalized Prefix Index data
export type RawPrefixIndexLine = {
  slug: string;
  values: Record<string, Record<string, string | string[]>>;
};

