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

export type StorageConfig =
  | { type: "filesystem"; baseDir?: string; output: string }
  | { type: "r2"; output: string }
  | { type: "browser"; baseUrl: string, output: '' };

export type StaticQLConfig = {
  storage: StorageConfig;
  sources: Record<string, SourceConfig>;
};

export type SourceRecord = {
  slug: string;
};
