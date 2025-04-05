import fs from "fs/promises";
import path from "node:path";
import matter from "gray-matter";
import yaml from "js-yaml";
import { globby } from "globby";
import type { ContentDBConfig, SourceConfig } from "./types";

export class DataLoader {
  private config: ContentDBConfig;
  private cache: Map<string, any[]> = new Map();

  constructor(config: ContentDBConfig) {
    this.config = config;
  }

  async load(sourceName: string): Promise<any[]> {
    if (this.cache.has(sourceName)) {
      return this.cache.get(sourceName)!;
    }

    const source = this.config.sources[sourceName];
    if (!source) throw new Error(`Unknown source: ${sourceName}`);

    const files = await globby(source.path);
    const parsed = await Promise.all(
      files.map((f) => this.parseFile(f, source, f))
    );

    const flattened =
      Array.isArray(parsed) && Array.isArray(parsed[0])
        ? parsed.flat()
        : parsed;

    source.schema.parse(flattened);
    this.cache.set(sourceName, flattened);
    return flattened;
  }

  async loadBySlug(sourceName: string, slug: string): Promise<any> {
    const source = this.config.sources[sourceName];
    if (!source) throw new Error(`Unknown source: ${sourceName}`);

    const ext = path.extname(source.path);
    const baseDir = path.dirname(source.path);

    const relativePath = slug.replace(/--/g, path.sep) + ext;
    const filePath = path.join(baseDir, relativePath);

    try {
      const parsed = await this.parseFile(filePath, source, filePath);
      source.schema.parse([parsed]);
      return parsed;
    } catch (err) {
      throw new Error(`Failed to loadBySlug: ${filePath} — ${err}`);
    }
  }

  private async parseFile(
    filePath: string,
    source: SourceConfig,
    fullPath: string
  ): Promise<any> {
    const ext = path.extname(fullPath);
    const raw = await fs.readFile(fullPath, "utf-8");

    let parsed: any;

    if (source.type === "markdown") {
      const { data, content } = matter(raw);
      parsed = { ...data, content };
    } else if (source.type === "yaml") {
      parsed = yaml.load(raw);
    } else if (source.type === "json") {
      parsed = JSON.parse(raw);
    } else {
      throw new Error(`Unsupported file type: ${ext}`);
    }

    if (
      source.path.includes("*") &&
      !Array.isArray(parsed) &&
      typeof parsed === "object" &&
      parsed !== null
    ) {
      const baseDir = path.dirname(source.path);
      const relative = path.relative(baseDir, filePath);
      const slugFromPath = relative.replace(ext, "").replace(/[\\/]/g, "--");

      if (!parsed.slug) {
        parsed.slug = slugFromPath;
      } else if (parsed.slug !== slugFromPath) {
        throw new Error(
          `slug mismatch: expected "${slugFromPath}", got "${parsed.slug}" in ${filePath}`
        );
      }
    }

    return parsed;
  }
}
