import { Indexer } from "./Indexer.js";
import { joinPath } from "./utils/path.js";
import { PrefixIndexDefinition, PrefixIndexDepth } from "./utils/typs.js";
import { JSONSchema7 } from "./validator/Validator.js";

/**
 * Represents a single content record, identified by a slug.
 */
export type SourceRecord = {
  slug: string;
  [key: string]: any;
};

/**
 * Supported content types.
 */
export type SourceType = "markdown" | "yaml" | "json";

/**
 * Configuration for a single source (as defined in user config).
 */
export interface SourceConfig {
  type: SourceType;
  pattern: string;
  schema: JSONSchema7;
  relations?: Record<string, Relation>;
  index?: (string | { [field: string]: { indexDepth?: PrefixIndexDepth } })[];
  customIndex?: (
    | string
    | { [field: string]: { indexDepth?: PrefixIndexDepth } }
  )[];
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
  indexes?: PrefixIndexDefinition;
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
   *
   * @returns
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
      slug: {
        dir: Indexer.getIndexDir(sourceName, "slug"),
        depth: Indexer.indexDepth,
      },
    };

    if (Array.isArray(source.index)) {
      for (const field of source.index) {
        const fieldName =
          typeof field === "object" ? Object.keys(field)[0] : field;
        const depth =
          typeof field === "object"
            ? field[fieldName]["indexDepth"] ?? Indexer.indexDepth
            : Indexer.indexDepth;

        if (!this.isDepthInRange(depth)) throw new Error("");

        indexes[fieldName] = {
          dir: Indexer.getIndexDir(sourceName, fieldName),
          depth,
        };
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
      for (const [_, rel] of relationalSources) {
        const fieldNames: Array<string | null> = [];

        if (
          rel.type === "belongsTo" ||
          rel.type === "belongsToMany" ||
          rel.type === "hasOne" ||
          rel.type === "hasMany"
        ) {
          fieldNames.push(rel.foreignKey === "slug" ? null : rel.foreignKey);
        } else if (
          rel.type === "hasOneThrough" ||
          rel.type === "hasManyThrough"
        ) {
          fieldNames.push(
            rel.targetForeignKey === "slug" ? null : rel.targetForeignKey
          );
          fieldNames.push(
            rel.throughForeignKey === "slug" ? null : rel.throughForeignKey
          );
        }

        if (!fieldNames.length) continue;

        for (const fieldName of fieldNames) {
          if (!fieldName) continue;

          indexes[fieldName] = {
            dir: Indexer.getIndexDir(sourceName, fieldName),
            depth: Indexer.indexDepth,
          };
        }
      }
    }

    // resolve customIndexes
    if (Array.isArray(source.customIndex)) {
      for (const field of source.customIndex) {
        const fieldName =
          typeof field === "object" ? Object.keys(field)[0] : field;
        const depth =
          typeof field === "object"
            ? field[fieldName]["indexDepth"] ?? Indexer.indexDepth
            : Indexer.indexDepth;

        if (!this.isDepthInRange(depth)) throw new Error("");

        indexes[fieldName] = {
          dir: Indexer.getIndexDir(sourceName, fieldName),
          depth,
        };
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
   *
   * @param rel
   * @returns
   */
  isThroughRelation(rel: Relation): rel is ThroughRelation {
    return (
      typeof rel === "object" &&
      "through" in rel &&
      (rel.type === "hasOneThrough" || rel.type === "hasManyThrough")
    );
  }

  /**
   * Check depth in range.
   */
  private isDepthInRange(n: number): n is PrefixIndexDepth {
    return n >= 2 && n <= 10;
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
    return index === -1 ? globPath : joinPath(...parts.slice(0, index)) + "/";
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
