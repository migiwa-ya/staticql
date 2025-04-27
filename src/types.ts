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
  type: "hasOne" | "hasMany" | "belongsTo" | "belongsToMany";
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

import type { R2Bucket } from "./storage/R2Provider";

export type StorageConfig =
  | { type: "filesystem"; baseDir?: string; output: string }
  | ({ type: "r2"; output: string } & { bucket: R2Bucket });

export type ContentDBConfig = {
  storage: StorageConfig;
  sources: Record<string, SourceConfig>;
};

export type SourceRecord = {
  slug: string;
};
