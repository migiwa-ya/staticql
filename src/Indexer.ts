import path from "path";
import fs from "fs/promises";
import { DataLoader } from "./DataLoader.js";
import { ContentDBConfig } from "./types";
import {
  resolveField,
  unwrapSingleArray,
  findEntriesByPartialKey,
} from "./utils.js";

export class Indexer {
  private loader: DataLoader;
  private config: ContentDBConfig;
  private cache: Record<string, any[]> | null = null;

  constructor(loader: DataLoader, config: ContentDBConfig) {
    this.loader = loader;
    this.config = config;
  }

  async buildAll(): Promise<Record<string, any[]>> {
    if (this.cache) return this.cache;

    const result: Record<string, any[]> = {};

    for (const [sourceName, sourceDef] of Object.entries(this.config.sources)) {
      if (!sourceDef.index) continue;

      let data = await this.loader.load(sourceName);

      const joins = Object.keys(sourceDef.relations ?? {});
      for (const key of joins) {
        const rel = sourceDef.relations![key];

        // Type guard for through relation
        const isThrough =
          typeof rel === "object" &&
          "through" in rel &&
          (rel.type === "hasOneThrough" || rel.type === "hasManyThrough");

        if (isThrough) {
          // Through relation (hasOneThrough, hasManyThrough)
          const throughData = await this.loader.load(rel.through);
          const throughMap = new Map(
            throughData.map((row) => [resolveField(row, rel.throughForeignKey) ?? "", row])
          );

          const targetData = await this.loader.load(rel.to);
          const targetMap = new Map(
            targetData.map((row) => [resolveField(row, rel.targetForeignKey) ?? "", row])
          );

          data = data.map((row) => {
            const sourceKey = resolveField(row, rel.sourceLocalKey);
            if (!sourceKey) return { ...row, [key]: rel.type === "hasManyThrough" ? [] : null };

            const throughMatches = throughData.filter(
              (t) =>
                (resolveField(t, rel.throughForeignKey) ?? "")
                  .split(" ")
                  .includes(sourceKey)
            );

            const targets = throughMatches
              .map((t) => {
                const throughKey = resolveField(t, rel.throughLocalKey);
                return (throughKey ?? "")
                  .split(" ")
                  .map((k) => targetMap.get(k))
                  .filter((v) => v);
              })
              .flat();

            if (rel.type === "hasOneThrough") {
              return { ...row, [key]: targets.length > 0 ? targets[0] : null };
            } else {
              // hasManyThrough
              return { ...row, [key]: targets };
            }
          });
        } else {
          // Type guard for direct relation
          const directRel = rel as Extract<typeof rel, { localKey: string; foreignKey: string }>;
          const foreignData = await this.loader.load(directRel.to);

          const foreignMap = new Map(
            foreignData.map((row) => [resolveField(row, directRel.foreignKey) ?? "", row])
          );

          data = data.map((row) => ({
            ...row,

            [key]:
              (resolveField(row, directRel.localKey) ?? "")
                .split(" ")
                .map((k) =>
                  unwrapSingleArray(findEntriesByPartialKey(foreignMap, k))
                )
                .filter((v) => v) ?? null,
          }));
        }
      }

      const records = data.map((row) => {
        const values: Record<string, string> = {};

        for (const field of sourceDef.index!) {
          const val = resolveField(row, field);
          if (val != null && String(val)) {
            values[field] = String(val);
          }
        }

        return {
          slug: row.slug,
          values,
        };
      });

      result[sourceName] = records;
    }

    this.cache = result;
    return result;
  }

  async saveTo(outputDir: string): Promise<void> {
    const all = await this.buildAll();
    await fs.mkdir(outputDir, { recursive: true });

    for (const [sourceName, records] of Object.entries(all)) {
      const filePath = path.join(outputDir, `${sourceName}.index.json`);
      await fs.writeFile(
        filePath,
        JSON.stringify(
          {
            fields: this.config.sources[sourceName].index,
            records,
          },
          null,
          2
        ),
        "utf-8"
      );
    }
  }
}
