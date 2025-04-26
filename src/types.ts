import { z } from "zod";

export type SourceType = "markdown" | "yaml" | "json";

export type SourceConfig = {
  path: string;
  type: SourceType;
  schema: z.ZodType<any, any>;
  index?: string[];
  meta?: string[];
  relations?: Record<string, RelationConfig>;
  splitIndexByKey?: boolean;
};

export type DirectRelation = {
  to: string;
  localKey: string;
  foreignKey: string;
  type?: "hasOne" | "hasMany";
};

export type ThroughRelation = {
  to: string;
  through: string;
  sourceLocalKey: string;
  throughForeignKey: string;
  throughLocalKey: string;
  targetForeignKey: string;
  type: "hasOneThrough" | "hasManyThrough";
};

export type RelationConfig = DirectRelation | ThroughRelation;

import type { S3ProviderOptions } from "./storage/S3Provider";

export type StorageConfig =
  | { type: "filesystem"; baseDir?: string }
  | ({ type: "s3" } & S3ProviderOptions);

export type ContentDBConfig = {
  sources: Record<string, SourceConfig>;
  storage?: StorageConfig;
};

export type SourceRecord = {
  slug: string;
};
