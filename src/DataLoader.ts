import matter from "gray-matter";
import yaml from "js-yaml";
import type { ContentDBConfig, SourceConfig } from "./types";
import type { StorageProvider } from "./storage/StorageProvider";

export class DataLoader {
  private config: ContentDBConfig;
  private provider: StorageProvider;
  private cache: Map<string, any[]> = new Map();

  constructor(config: ContentDBConfig, provider: StorageProvider) {
    this.config = config;
    this.provider = provider;
  }

  async load(sourceName: string): Promise<any[]> {
    if (this.cache.has(sourceName)) {
      return this.cache.get(sourceName)!;
    }

    const source = this.config.sources[sourceName];
    if (!source) throw new Error(`Unknown source: ${sourceName}`);

    const files = await this.provider.listFiles(source.path);
    const parsed = await Promise.all(
      files.map((f: string) => this.parseFile(f, source, f))
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

    const ext = this.getExtname(source.path);

    const relativePath = slug.replace(/--/g, "/") + ext;
    const filePath = this.resolveFilePath(source.path, relativePath);

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
    const ext = this.getExtname(fullPath);
    let raw = await this.provider.readFile(fullPath);
    if (raw instanceof Uint8Array) {
      raw = new TextDecoder().decode(raw);
    }

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
      const slugFromPath = this.getSlugFromPath(source.path, filePath);

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

  // 拡張子取得（Node.js非依存）
  private getExtname(p: string): string {
    const i = p.lastIndexOf(".");
    if (i === -1) return "";
    return p.slice(i);
  }

  // slug生成（Node.js非依存）
  private getSlugFromPath(sourcePath: string, filePath: string): string {
    // sourcePath例: "tests/content-fixtures/herbs/*.md"
    // filePath例: "tests/content-fixtures/herbs/matricaria-chamomilla.md"
    // slug: "matricaria-chamomilla"
    const ext = this.getExtname(filePath);
    const baseDir = this.extractBaseDir(sourcePath);
    let rel = filePath.startsWith(baseDir)
      ? filePath.slice(baseDir.length)
      : filePath;
    if (rel.startsWith("/")) rel = rel.slice(1);
    const slug = rel.replace(ext, "").replace(/\//g, "--");
    return slug;
  }

  // sourcePathからワイルドカードより前のディレクトリ部分を抽出
  private extractBaseDir(globPath: string): string {
    const parts = globPath.split("/");
    const index = parts.findIndex((part) => part.includes("*"));
    if (index === -1) return globPath;
    return parts.slice(0, index).join("/") + "/";
  }

  // sourceGlob, relativePathから論理パスを生成
  private resolveFilePath(sourceGlob: string, relativePath: string): string {
    const baseDir = this.extractBaseDir(sourceGlob);
    return baseDir + relativePath;
  }
}
