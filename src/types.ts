import { z } from 'zod';

export type SourceType = 'markdown' | 'yaml' | 'json';

export type SourceConfig = {
  path: string;
  type: SourceType;
  schema: z.ZodType<any, any>;
  index?: string[];
  relations?: Record<string, RelationConfig>;
};

export type RelationConfig =
  | {
      // Direct relation (hasOne, hasMany, belongsTo)
      to: string;
      localKey: string;
      foreignKey: string;
      type?: "hasOne" | "hasMany" | "belongsTo";
    }
  | {
      // Through relation (hasOneThrough, hasManyThrough)
      to: string; // Target model
      through: string; // Intermediate model
      sourceLocalKey: string; // Key on source to match with through
      throughForeignKey: string; // Key on through to match with source
      throughLocalKey: string; // Key on through to match with target
      targetForeignKey: string; // Key on target to match with through
      type: "hasOneThrough" | "hasManyThrough";
    };

export type ContentDBConfig = {
  sources: Record<string, SourceConfig>;
};
