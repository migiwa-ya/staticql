import { Indexer } from "./Indexer.js";

export type SourceRecord = {
  slug: string;
};

export type SourceType = "markdown" | "yaml" | "json";

// 暫定的なJSON Schema型
type JSONSchema7 = {
  type?: string;
  properties?: {
    [key: string]: JSONSchema7;
  };
  items?: JSONSchema7;
  required?: string[];
  enum?: string[];
  [key: string]: any; // その他プロパティの許容（緩めの設定）
};

export interface SourceConfig {
  type: SourceType;
  pattern: string;
  schema: JSONSchema7;
  relations?: Record<string, Relation>;
  index?: string[];
  splitIndexByKey?: boolean;
}

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

export type DirectRelation = {
  to: string;
  localKey: string;
  foreignKey: string;
  type: "hasOne" | "hasMany" | "belongsTo" | "belongsToMany";
};

export type ThroughRelation = {
  to: string;
  through: string;
  sourceLocalKey: string;
  throughForeignKey: string;
  throughLocalKey: string;
  targetForeignKey: string;
  type: "hasOneThrough" | "hasManyThrough";
};

export type Relation = DirectRelation | ThroughRelation;

export class SourceConfigResolver {
  private cache: Record<string, ResolvedSourceConfig> = {};

  constructor(private readonly sources: Record<string, SourceConfig>) {}

  resolveAll(): ResolvedSourceConfig[] {
    if (Object.values(this.cache).length !== 0) {
      return Object.values(this.cache);
    }

    for (const [name] of Object.entries(this.sources)) {
      this.cache[name] = this.resolveOne(name);
    }

    return Object.values(this.cache);
  }

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
        Object.entries(source.relations ?? {}).find(
          ([_, rel]) => rel.to === sourceName
        )
      )
      .filter(Boolean)
      .filter((e): e is [string, Relation] => !!e);

    if (relationalSources) {
      for (const [relKey, rel] of relationalSources) {
        let field;
        if (rel.type === "belongsTo" || rel.type === "belongsToMany") {
          field = rel.foreignKey === "slug" ? null : rel.foreignKey;
        } else if (rel.type === "hasOne" || rel.type === "hasMany") {
          field = rel.foreignKey === "slug" ? null : rel.foreignKey;
        } else if (
          rel.type === "hasOneThrough" ||
          rel.type === "hasManyThrough"
        ) {
          field =
            rel.targetForeignKey === "slug"
              ? null
              : `${rel.targetForeignKey}.slug`;
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

    const result = {
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

  static getSourcePathsBySlugs(pattern: string, slugs: string[]): string[] {
    const extMatch = pattern.match(/\.(\w+)$/);
    const ext = extMatch ? "." + extMatch[1] : "";

    let filteredSlugs = slugs;
    if (pattern.includes("*")) {
      const wcIdx = pattern.indexOf("*");
      let slugPattern = pattern.slice(wcIdx);
      slugPattern = this.pathToSlug(slugPattern);
      slugPattern = slugPattern.replace(/\.[^\.]+$/, "");
      slugPattern = slugPattern
        .replace(/\*\*/g, "([\\w-]+(--)?)*")
        .replace(/\*/g, "[\\w-]+");
      const regex = new RegExp("^" + slugPattern + "$");
      filteredSlugs = slugs.filter((slug) => regex.test(slug));
    }

    // slug→パス変換
    return filteredSlugs.map((slug) =>
      this.resolveFilePath(pattern, this.slugToPath(slug) + ext)
    );
  }

  /**
   * slug（--区切り）をパス（/区切り）に変換
   * @param slug
   * @returns パス文字列
   */
  static slugToPath(slug: string): string {
    return slug.replace(/--/g, "/");
  }

  /**
   * パス（/区切り）をslug（--区切り）に変換
   * @param path
   * @returns パス文字列
   */
  static pathToSlug(path: string): string {
    return path.replace(/\//g, "--");
  }

  /**
   * globパターンからワイルドカードより前のディレクトリ部分を抽出
   * @param globPath - globを含むパス
   * @returns ディレクトリパス
   */
  static extractBaseDir(globPath: string): string {
    const parts = globPath.split("/");
    const index = parts.findIndex((part) => part.includes("*"));

    if (index === -1) return globPath;
    return parts.slice(0, index).join("/") + "/";
  }

  /**
   * sourceGlob, relativePathから論理パスを生成
   * @param sourceGlob - globを含むパス
   * @param relativePath - 相対パス
   * @returns 論理パス
   */
  static resolveFilePath(sourceGlob: string, relativePath: string): string {
    const baseDir = this.extractBaseDir(sourceGlob);

    return baseDir + relativePath;
  }

  /**
   * ファイルパスからslug（論理ID）を生成
   * @param sourcePath - 設定で定義されたsourceのパス（glob含む）
   * @param filePath - 実際のファイルパス
   * @returns slug文字列
   */
  static getSlugFromPath(sourcePath: string, filePath: string): string {
    const ext = filePath.slice(filePath.lastIndexOf(".")) || "";
    const baseDir = this.extractBaseDir(sourcePath);
    let rel = filePath.startsWith(baseDir)
      ? filePath.slice(baseDir.length)
      : filePath;
    if (rel.startsWith("/")) rel = rel.slice(1);

    const slug = this.pathToSlug(rel.replace(ext, ""));

    return slug;
  }
}
