import { Validator } from "./validator/Validator.js";
import { parseByType } from "./parser/index.js";
import type { StorageRepository } from "./repository/StorageRepository.js";
import {
  ResolvedSourceConfig as RSC,
  SourceConfigResolver as Resolver,
} from "./SourceConfigResolver.js";

/**
 * Responsible for loading and validating content from static sources.
 */
export class SourceLoader<T> {
  constructor(
    private repository: StorageRepository,
    private resolver: Resolver,
    private validator: Validator
  ) {}

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
      const parsed = await this.parseFile(filePath, rsc, filePath);

      if (Array.isArray(parsed)) {
        const found = parsed.find((item) => item && item.slug === slug);
        if (!found) throw new Error(`Slug not found in file: ${filePath}`);
        this.validator.validate(found, rsc.schema, rsc.name);
        return found as T;
      } else {
        this.validator.validate(parsed, rsc.schema, rsc.name);
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
    const results = await Promise.allSettled(
      slugs.map((slug) => this.loadBySlug(sourceName, slug))
    );

    return results
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<T>> => r.status === "fulfilled"
      )
      .map((r) => r.value);
  }

  /**
   * Parses and validates a single file.
   * Ensures slug consistency if the file name pattern contains wildcards.
   *
   * @param filePath - Logical file path (may include pattern).
   * @param rsc - The resolved source configuration.
   * @param fullPath - Actual resolved file path.
   * @returns Parsed and validated record(s).
   * @throws If the slug is inconsistent or unsupported type.
   */
  private async parseFile(
    filePath: string,
    rsc: RSC,
    fullPath: string
  ): Promise<T> {
    const ext = this.getExtname(fullPath);
    let raw = await this.repository.readFile(fullPath);
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
      } else if (parsedObj.slug !== slugFromPath) {
        throw new Error(
          `Slug mismatch: expected "${slugFromPath}", got "${parsedObj.slug}" in ${filePath}`
        );
      }

      parsed = parsedObj;
    }

    return parsed as T;
  }

  /**
   * Extracts the file extension from a path string.
   *
   * @param p - File path.
   * @returns The extension (e.g., ".md", ".yaml").
   */
  private getExtname(p: string): string {
    const i = p.lastIndexOf(".");
    if (i === -1) return "";
    return p.slice(i);
  }
}
