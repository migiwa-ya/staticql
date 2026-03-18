import { joinPath } from "./utils/path.js";
import { PrefixIndexDefinition, PrefixIndexDepth } from "./utils/typs.js";
import { JSONSchema7 } from "./validator/Validator.js";
import { IndexConfigFactory } from "./IndexConfigFactory.js";

// Re-export types from types.ts for backward compatibility
export type {
  SourceRecord,
  DirectRelation,
  ThroughRelation,
  Relation,
} from "./types.js";
import type { Relation } from "./types.js";

/**
 * Supported content types.
 */
export type SourceType = string;

/**
 * Configuration for a single source (as defined in user config).
 */
export interface SourceConfig {
  type: SourceType;
  pattern: string;
  schema: JSONSchema7;
  relations?: Record<string, Relation>;
  index?: Record<string, { indexDepth?: PrefixIndexDepth }>;
  customIndex?: Record<string, { indexDepth?: PrefixIndexDepth }>;
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
 * Resolves user-defined source configurations into a normalized internal format.
 */
export class SourceConfigResolver {
  private cache: Record<string, ResolvedSourceConfig> = {};
  private indexConfigFactory = new IndexConfigFactory();

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

    const indexes = this.indexConfigFactory.buildForSource(
      sourceName,
      source,
      this.sources
    );

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
  isThroughRelation(rel: Relation): rel is import("./types.js").ThroughRelation {
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

  static patternTest(pattern: string, filePath: string): boolean {
    return this.globToRegExp(pattern).test(filePath);
  }

  private static globToRegExp(glob: string): RegExp {
    const p = glob.replace(/\\/g, "/");

    let re = "^";
    let i = 0;
    while (i < p.length) {
      const c = p[i];

      if (c === "*") {
        if (p[i + 1] === "*") {
          i++;
          const isSlash = p[i + 1] === "/";
          if (isSlash) i++;
          re += isSlash ? "(?:[^/]+/)*" : "(?:[^/]+/)*[^/]*";
        } else {
          re += "[^/]*";
        }
      } else {
        re += c.replace(/[$^+.()|{}]/g, "\\$&");
      }
      i++;
    }
    re += "$";
    return new RegExp(re);
  }
}
