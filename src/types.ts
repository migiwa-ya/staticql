import { z } from 'zod';

export type SourceType = 'markdown' | 'yaml' | 'json';

export type SourceConfig = {
  path: string;
  type: SourceType;
  schema: z.ZodType<any, any>;
  index?: string[];
  relations?: Record<string, RelationConfig>;
};

export type RelationConfig = {
  to: string;
  localKey: string;
  foreignKey: string;
};

export type ContentDBConfig = {
  sources: Record<string, SourceConfig>;
};
