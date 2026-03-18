/**
 * Shared domain types used across multiple modules.
 *
 * This module exists to break circular dependencies between
 * constants.ts, SourceConfigResolver.ts, IndexBuilder.ts, etc.
 */

/**
 * Represents a single content record, identified by a slug.
 */
export type SourceRecord = {
  slug: string;
  raw: string;
  [key: string]: any;
};

/**
 * Direct relation to another source.
 */
export type DirectRelation = {
  to: string;
  localKey: string;
  foreignKey: string;
  type: "hasOne" | "hasMany" | "belongsTo" | "belongsToMany";
};

/**
 * Through (intermediate) relation to another source.
 */
export type ThroughRelation = {
  to: string;
  through: string;
  sourceLocalKey: string;
  throughForeignKey: string;
  throughLocalKey: string;
  targetForeignKey: string;
  type: "hasOneThrough" | "hasManyThrough";
};

/**
 * Any supported relation type.
 */
export type Relation = DirectRelation | ThroughRelation;

/**
 * Represents a file diff entry (for incremental index updates).
 */
export type DiffEntry = {
  status: "A" | "D" | "M";
  source: string;
  slug: string;
  fields?: Record<string, unknown>;
};

/**
 * Relation map for direct relations (used during index building).
 */
export type DirectRelationMap = { foreignMap: Map<string, SourceRecord[]> };

/**
 * Relation map for through relations (used during index building).
 */
export type ThroughRelationMap = {
  targetMap: Map<string, SourceRecord[]>;
  throughMap: Map<string, SourceRecord[]>;
};
