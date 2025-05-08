import { Indexer } from "./Indexer.js";

/**
 * Represents a single content record, identified by a slug.
 */
export type SourceRecord = {
  slug: string;
};

/**
 * Supported content types.
 */
export type SourceType = "markdown" | "yaml" | "json";

/**
 * Loosely-typed JSON Schema (for validation and structure hinting).
 */
type JSONSchema7 = {
  type?: string;
  properties?: Record<string, JSONSchema7>;
  items?: JSONSchema7;
  required?: string[];
  enum?: string[];
  [key: string]: any; // Allow additional schema keywords
};

/**
 * Configuration for a single source (as defined in user config).
 */
export interface SourceConfig {
  type: SourceType;
  pattern: string;
  schema: JSONSchema7;
  relations?: Record<string, Relation>;
  index?: string[];
  splitIndexByKey?: boolean;
}

/**
 * Internally resolved and enriched source configuration.
 */
export interface ResolvedSourceConfig {
  name: string;
  type: SourceType;
  pattern: string;
  schema: JSONSchema7;
  relations?: Record<string, Relation>;
  indexes?: {
    fields?: Record<string, string>;
    split?: Record<string, string>;
    all?: string;
  };
}

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
 * Resolves user-defined source configurations into a normalized internal format.
 */
export class SourceConfigResolver {
  private cache: Record<string, ResolvedSourceConfig> = {};

  constructor(private readonly sources: Record<string, SourceConfig>) {}

  /**
   * Resolves all sources and returns the enriched configurations.
   */
  resolveAll(): ResolvedSourceConfig[] {
    if (Object.values(this.cache).length !== 0) {
      return Object.values(this.cache);
    }

    for (const [name] of Object.entries(this.sources)) {
      this.cache[name] = this.resolveOne(name);
    }

    return Object.values(this.cache);
  }

  /**
   * Resolves a single source by name.
   *
   * @param sourceName - The name of the source.
   * @returns Resolved configuration.
   * @throws If the source does not exist.
   */
  resolveOne(sourceName: string): ResolvedSourceConfig {
    if (this.cache[sourceName]) {
      return this.cache[sourceName];
    }

    const source = this.sources[sourceName];
    if (!source) throw new Error(`Source not found: ${sourceName}`);

    const indexes: ResolvedSourceConfig["indexes"] = {
      fields: {},
      split: {},
      all: Indexer.getSlugIndexFilePath(sourceName),
    };

    if (Array.isArray(source.index)) {
      for (const field of source.index) {
        if (source.splitIndexByKey) {
          indexes.split![field] = Indexer.getSplitIndexDir(sourceName, field);
        } else {
          indexes.fields![field] = Indexer.getFieldIndexFilePath(
            sourceName,
            field
          );
        }
      }
    }

    const relationalSources = Object.entries(this.sources)
      .filter(([name]) => name !== sourceName)
      .map(([_, source]) =>
        Object.entries(source.relations ?? {}).find(([_, rel]) =>
          this.isThroughRelation(rel)
            ? rel.to === sourceName || rel.through === sourceName
            : rel.to === sourceName
        )
      )
      .filter(Boolean)
      .filter((e): e is [string, Relation] => !!e);

    if (relationalSources) {
      for (const [relKey, rel] of relationalSources) {
        let field: string | null = null;

        if (
          rel.type === "belongsTo" ||
          rel.type === "belongsToMany" ||
          rel.type === "hasOne" ||
          rel.type === "hasMany"
        ) {
          field = rel.foreignKey === "slug" ? null : rel.foreignKey;
        } else if (
          rel.type === "hasOneThrough" ||
          rel.type === "hasManyThrough"
        ) {
          if (rel.to === sourceName) {
            field =
              rel.targetForeignKey === "slug" ? null : rel.targetForeignKey;
          } else {
            field = rel.throughLocalKey === "slug" ? null : rel.throughLocalKey;
          }
        }

        if (!field) continue;

        if (source.splitIndexByKey) {
          indexes.split![field] = Indexer.getSplitIndexDir(sourceName, field);
        } else {
          indexes.fields![field] = Indexer.getFieldIndexFilePath(
            sourceName,
            field
          );
        }
      }
    }

    const result: ResolvedSourceConfig = {
      name: sourceName,
      pattern: source.pattern,
      type: source.type,
      schema: source.schema,
      relations: source.relations,
      indexes,
    };

    this.cache[sourceName] = result;

    return result;
  }

  /**
   * Determines whether a relation is a through (indirect) relation.
   */
  isThroughRelation(rel: Relation): rel is ThroughRelation {
    return (
      typeof rel === "object" &&
      "through" in rel &&
      (rel.type === "hasOneThrough" || rel.type === "hasManyThrough")
    );
  }

  /**
   * Converts a list of slugs into full paths based on a glob pattern.
   */
  static getSourcePathsBySlugs(pattern: string, slugs: string[]): string[] {
    const extMatch = pattern.match(/\.(\w+)$/);
    const ext = extMatch ? "." + extMatch[1] : "";

    let filteredSlugs = slugs;

    if (pattern.includes("*")) {
      const wcIdx = pattern.indexOf("*");
      let slugPattern = pattern.slice(wcIdx);
      slugPattern = this.pathToSlug(slugPattern).replace(/\.[^\.]+$/, "");
      slugPattern = slugPattern
        .replace(/\*\*/g, "([\\w-]+(--)?)*")
        .replace(/\*/g, "[\\w-]+");

      const regex = new RegExp("^" + slugPattern + "$");
      filteredSlugs = slugs.filter((slug) => regex.test(slug));
    }

    return filteredSlugs.map((slug) =>
      this.resolveFilePath(pattern, this.slugToPath(slug) + ext)
    );
  }

  /**
   * Converts a slug (with `--`) to a file path (`/`).
   */
  static slugToPath(slug: string): string {
    return slug.replace(/--/g, "/");
  }

  /**
   * Converts a path (`/`) to a slug (with `--`).
   */
  static pathToSlug(path: string): string {
    return path.replace(/\//g, "--");
  }

  /**
   * Extracts the base directory from a glob pattern (up to the first wildcard).
   */
  static extractBaseDir(globPath: string): string {
    const parts = globPath.split("/");
    const index = parts.findIndex((part) => part.includes("*"));
    return index === -1 ? globPath : parts.slice(0, index).join("/") + "/";
  }

  /**
   * Resolves a logical file path from a glob source and a relative path.
   */
  static resolveFilePath(sourceGlob: string, relativePath: string): string {
    const baseDir = this.extractBaseDir(sourceGlob);
    return baseDir + relativePath;
  }

  /**
   * Extracts the slug from a full file path using the source glob.
   */
  static getSlugFromPath(sourcePath: string, filePath: string): string {
    const ext = filePath.slice(filePath.lastIndexOf(".")) || "";
    const baseDir = this.extractBaseDir(sourcePath);
    let rel = filePath.startsWith(baseDir)
      ? filePath.slice(baseDir.length)
      : filePath;
    if (rel.startsWith("/")) rel = rel.slice(1);
    return this.pathToSlug(rel.replace(ext, ""));
  }
}
