import { Relation } from "./types.js";
import { getIndexDir, DEFAULT_INDEX_DEPTH, isThroughRelation } from "./constants.js";
import { PrefixIndexDefinition, PrefixIndexDepth } from "./utils/typs.js";

/**
 * User-defined index configuration for a source.
 */
type IndexDefinition = Record<string, { indexDepth?: PrefixIndexDepth }>;

/**
 * Input needed to build index config for a source.
 */
export interface IndexConfigInput {
  index?: IndexDefinition;
  customIndex?: IndexDefinition;
  relations?: Record<string, Relation>;
}

/**
 * Builds index configurations for sources.
 *
 * Extracted from SourceConfigResolver to separate the concern of
 * index directory/depth resolution from source configuration resolution.
 */
export class IndexConfigFactory {
  /**
   * Builds the full index definition for a source, including:
   * - Default slug index
   * - User-defined field indexes
   * - Relation-derived indexes (auto-generated from foreign keys)
   * - Custom indexes
   */
  buildForSource(
    sourceName: string,
    source: IndexConfigInput,
    allSources: Record<string, IndexConfigInput>
  ): PrefixIndexDefinition {
    const indexes: PrefixIndexDefinition = {
      slug: {
        dir: getIndexDir(sourceName, "slug"),
        depth: DEFAULT_INDEX_DEPTH,
      },
    };

    // User-defined field indexes
    if (source.index) {
      for (const [fieldName, definition] of Object.entries(source.index)) {
        const depth = definition["indexDepth"] ?? DEFAULT_INDEX_DEPTH;

        if (!this.isDepthInRange(depth))
          throw new Error(
            `[${sourceName}] index depth ${depth} for field "${fieldName}" is out of range (1-10)`
          );

        indexes[fieldName] = {
          dir: getIndexDir(sourceName, fieldName),
          depth,
        };
      }
    }

    // Relation-derived indexes
    const relationalSources = this.collectRelationalSources(
      sourceName,
      source,
      allSources
    );

    for (const [_, rel] of relationalSources) {
      const fieldNames = this.getRelationIndexFields(sourceName, rel);

      for (const fieldName of fieldNames) {
        if (!fieldName) continue;

        indexes[fieldName] = {
          dir: getIndexDir(sourceName, fieldName),
          depth: DEFAULT_INDEX_DEPTH,
        };
      }
    }

    // Custom indexes
    if (source.customIndex) {
      for (const [fieldName, definition] of Object.entries(
        source.customIndex
      )) {
        const depth = definition["indexDepth"] ?? DEFAULT_INDEX_DEPTH;

        if (!this.isDepthInRange(depth))
          throw new Error(
            `[${sourceName}] index depth ${depth} for custom field "${fieldName}" is out of range (1-10)`
          );

        indexes[fieldName] = {
          dir: getIndexDir(sourceName, fieldName),
          depth,
        };
      }
    }

    return indexes;
  }

  /**
   * Collects relation entries relevant to a source (both own and referencing).
   */
  private collectRelationalSources(
    sourceName: string,
    source: IndexConfigInput,
    allSources: Record<string, IndexConfigInput>
  ): [string, Relation][] {
    const fromOtherSources = Object.entries(allSources)
      .filter(([name]) => name !== sourceName)
      .map(([_, s]) =>
        Object.entries(s.relations ?? {}).find(([_, rel]) =>
          isThroughRelation(rel)
            ? rel.to === sourceName || rel.through === sourceName
            : rel.to === sourceName
        )
      )
      .filter(Boolean)
      .filter((e): e is [string, Relation] => !!e);

    return [...fromOtherSources, ...Object.entries(source.relations ?? {})];
  }

  /**
   * Determines which fields need auto-generated indexes for a relation.
   */
  private getRelationIndexFields(
    sourceName: string,
    rel: Relation
  ): Array<string | null> {
    const fieldNames: Array<string | null> = [];

    if (
      rel.type === "belongsTo" ||
      rel.type === "belongsToMany" ||
      rel.type === "hasOne" ||
      rel.type === "hasMany"
    ) {
      if (rel.to === sourceName) {
        fieldNames.push(rel.foreignKey === "slug" ? null : rel.foreignKey);
      } else {
        fieldNames.push(rel.localKey === "slug" ? null : rel.localKey);
      }
    } else if (
      rel.type === "hasOneThrough" ||
      rel.type === "hasManyThrough"
    ) {
      if (rel.to === sourceName) {
        fieldNames.push(
          rel.throughForeignKey === "slug" ? null : rel.throughForeignKey
        );
      } else {
        fieldNames.push(
          rel.targetForeignKey === "slug" ? null : rel.targetForeignKey
        );
      }
    }

    return fieldNames;
  }

  private isDepthInRange(n: number): n is PrefixIndexDepth {
    return n >= 1 && n <= 10;
  }
}
