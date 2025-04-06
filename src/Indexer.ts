import path from "path";
import fs from "fs/promises";
import { DataLoader } from "./DataLoader";
import { ContentDBConfig } from "./types";
import {
  resolveField,
  unwrapSingleArray,
  findEntriesByPartialKey,
} from "./utils";

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
        const foreignData = await this.loader.load(rel.to);

        const foreignMap = new Map(
          foreignData.map((row) => [resolveField(row, rel.foreignKey), row])
        );

        data = data.map((row) => ({
          ...row,

          [key]:
            resolveField(row, rel.localKey)
              ?.split(" ")
              .map((key) =>
                unwrapSingleArray(findEntriesByPartialKey(foreignMap, key))
              )
              .filter((v) => v) ?? null,
        }));
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
