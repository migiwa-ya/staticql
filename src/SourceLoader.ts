import { Validator } from "./validator/Validator.js";
import { parseByType } from "./parser/index.js";
import type { StorageRepository } from "./repository/StorageRepository.js";
import {
  ResolvedSourceConfig as RSC,
  SourceConfigResolver as Resolver,
  SourceRecord,
} from "./SourceConfigResolver.js";
import { InMemoryCacheProvider } from "./cache/InMemoryCacheProvider.js";
import { CacheProvider } from "./cache/CacheProvider.js";

/**
 * Responsible for loading and validating content from static sources.
 */
export class SourceLoader<T extends SourceRecord> {
  private cache: CacheProvider;

  constructor(
    private repository: StorageRepository,
    private resolver: Resolver,
    private validator: Validator
  ) {
    this.cache = new InMemoryCacheProvider();
  }

  /**
   * Loads all records for a given source name.
   *
   * @param sourceName - The name of the source defined in config.
   * @returns An array of validated records.
   */
  async loadBySourceName(sourceName: string): Promise<T[]> {
    const rsc = this.resolver.resolveOne(sourceName);
    const filePaths = await this.repository.listFiles(rsc.pattern);
    const data: any[] = [];

    for (const filePath of filePaths) {
      data.push(await this.load(filePath, rsc));
    }

    const flattened =
      Array.isArray(data) && Array.isArray(data[0]) ? data.flat() : data;

    return flattened;
  }

  /**
   * Loads and validates content from a specific file path.
   *
   * @param filePath - The path to the file.
   * @param rsc - The resolved source configuration.
   * @returns Parsed and validated content.
   */
  async load(filePath: string, rsc: RSC) {
    if (!(await this.repository.exists(filePath))) {
      throw new Error(`Target Source [${filePath}] is not found.`);
    }

    const rawContent = await this.repository.readFile(filePath);
    const parsed = await parseByType(rsc.type, { rawContent });
    let validated = [];

    if (Array.isArray(parsed)) {
      parsed.map((p) => this.validator.validate(p, rsc.schema, rsc.name));
      validated = parsed.flat();
    } else {
      parsed.slug = Resolver.getSlugFromPath(rsc.pattern, filePath);
      this.validator.validate(parsed, rsc.schema, rsc.name);
      validated = parsed;
    }

    return validated;
  }

  /**
   * Loads and validates a single record by source name and slug.
   * If the file contains an array of records, the one matching the slug is returned.
   *
   * @param sourceName - The name of the source defined in config.
   * @param slug - The unique slug identifier.
   * @returns The matching validated record.
   * @throws If the source or slug is not found or fails validation.
   */
  async loadBySlug(sourceName: string, slug: string): Promise<T> {
    const rsc = this.resolver.resolveOne(sourceName);
    if (!rsc) throw new Error(`Unknown source: ${sourceName}`);

    let filePath: string;

    if (rsc.pattern.includes("*")) {
      filePath = Resolver.getSourcePathsBySlugs(rsc.pattern, [slug])[0];
    } else {
      filePath = rsc.pattern;
    }

    try {
      const { parsed, raw } = await this.parseFile(filePath, rsc);

      if (Array.isArray(parsed)) {
        const found = parsed.find((item) => item && item.slug === slug);
        if (!found)
          throw new Error(`Slug '${slug}' not found in file: ${filePath}`);
        this.validator.validate(found, rsc.schema, rsc.name);
        found.raw = raw;
        return found as T;
      } else {
        this.validator.validate(parsed, rsc.schema, rsc.name);
        parsed.raw = raw;
        return parsed as T;
      }
    } catch (err) {
      throw new Error(`Failed to loadBySlug: ${filePath} — ${err}`);
    }
  }

  /**
   * Loads and validates multiple records by slugs for the given source.
   *
   * @param sourceName - The name of the source.
   * @param slugs - Array of slug identifiers.
   * @returns An array of matched and validated records.
   */
  async loadBySlugs(sourceName: string, slugs: string[]): Promise<T[]> {
    const unique = [...new Set(slugs)];

    return Promise.all(unique.map((slug) => this.loadBySlug(sourceName, slug)));
  }

  /**
   * Parses and validates a single file.
   * Ensures slug consistency if the file name pattern contains wildcards.
   *
   * @param filePath - Logical file path (may include pattern).
   * @param rsc - The resolved source configuration.
   * @param fullPath - Actual resolved file path.
   * @returns Parsed and validated record and raw data.
   * @throws If the slug is inconsistent or unsupported type.
   */
  private async parseFile(
    filePath: string,
    rsc: RSC
  ): Promise<{ parsed: T; raw: string }> {
    if (await this.cache.has(filePath)) {
      const cached = await this.cache.get<{ parsed: T; raw: string }>(filePath);
      if (cached) return cached;
    }

    let raw = await this.repository.readFile(filePath);
    let parsed = await parseByType(rsc.type, { rawContent: raw });

    if (
      rsc.pattern.includes("*") &&
      !Array.isArray(parsed) &&
      typeof parsed === "object" &&
      parsed !== null
    ) {
      const slugFromPath = Resolver.getSlugFromPath(rsc.pattern, filePath);
      const parsedObj = parsed as Record<string, unknown>;

      if (!parsedObj.slug) {
        parsedObj.slug = slugFromPath;
      } else if (!slugFromPath.includes(String(parsedObj.slug))) {
        throw new Error(
          `Slug mismatch: expected "${slugFromPath}", got "${parsedObj.slug}" in ${filePath}`
        );
      }

      parsed = parsedObj;
    }

    await this.cache.set(filePath, { parsed, raw });

    return { parsed, raw };
  }
}
