#!/usr/bin/env node

import path from "path";
import { pathToFileURL } from "url";
import { StaticQL } from "../src/StaticQL.js";
import { StaticQLConfig } from "../src/types.js";
import { ZodTypeAny, ZodArray, ZodObject } from "zod";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  getFieldIndexFilePath,
  getSourceIndexFilePath,
  getSplitIndexFilePath,
} from "../src/utils/path.js";

function zodToJsonSchema(zodSchema: ZodTypeAny): any {
  if (zodSchema instanceof ZodArray) {
    return {
      type: "array",
      items: zodToJsonSchema(zodSchema._def.type),
    };
  }

  if (zodSchema instanceof ZodObject) {
    const shape = zodSchema.shape;
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const [key, val] of Object.entries(shape)) {
      const unwrapped = unwrapOptional(val);
      properties[key] = zodToJsonSchema(unwrapped);
      if (!isOptional(val)) {
        required.push(key);
      }
    }

    return {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties,
      required,
    };
  }

  const name = zodSchema._def?.typeName;
  switch (name) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodArray":
      return { type: "array", items: { type: "string" } }; // fallback
    default:
      return { type: "string" };
  }
}

function unwrapOptional(z: any): ZodTypeAny {
  const name = z._def?.typeName;
  if (
    name === "ZodOptional" ||
    name === "ZodNullable" ||
    name === "ZodDefault"
  ) {
    return unwrapOptional(z._def.innerType);
  }
  return z;
}

function isOptional(z: any): boolean {
  const name = z._def?.typeName;
  return name === "ZodOptional" || name === "ZodDefault";
}

function removePublicPath(path: string): string {
  return path.replace(/.*public\/?/, "");
}

function createSchema(config: StaticQLConfig, outDir: string) {
  const out: any = {
    storage: {
      type: "browser",
      baseUrl: "",
      output: "",
    },
    sources: {},
  };

  // outDir から schema ディレクトリを決定
  const schemaDir = join(outDir, "schema");
  mkdirSync(schemaDir, { recursive: true });

  for (const [name, source] of Object.entries(config.sources)) {
    const schemaFileRel = `schema/${name}.schema.json`;
    const sourceOut: any = {
      path: removePublicPath(source.path),
      type: source.type,
      schemaPath: schemaFileRel,
      splitIndexByKey: source.splitIndexByKey,
    };

    if (source.relations) {
      sourceOut.relations = source.relations;
    }

    if (config.storage.type === "browser") {
      throw new Error(
        "staticql.config.ts の storage.type の値が正しくありません。"
      );
    }

    // --- インデックスファイルパス列挙 ---
    const outputDir = config.storage.output.replace(/\/$/, "");
    const indexFields: string[] = [...(source.index ?? [])];
    // relations 由来の自動追加分も考慮
    if (source.relations) {
      for (const [relKey, rel] of Object.entries(source.relations)) {
        if (rel.type === "belongsTo" || rel.type === "belongsToMany") {
          indexFields.push(rel.foreignKey);
        } else {
          indexFields.push(`${relKey}.slug`);
        }
      }
    }
    // 重複除去
    const uniqueIndexFields = Array.from(new Set(indexFields));

    const indexes: any = {
      all: removePublicPath(getSourceIndexFilePath(outputDir, name)),
      fields: [],
      split: [],
    };

    for (const field of uniqueIndexFields) {
      if (source.splitIndexByKey) {
        // 分割方式: ワイルドカードで表現
        indexes.split.push(
          removePublicPath(getSplitIndexFilePath(outputDir, name, field, "*"))
        );
      } else {
        indexes.fields.push(
          removePublicPath(getFieldIndexFilePath(outputDir, name, field))
        );
      }
    }

    sourceOut.indexes = indexes;
    // --- インデックスファイルパス列挙ここまで ---

    // schema 部分を JSON Schema に変換して個別出力
    const schema = zodToJsonSchema(source.schema);
    const schemaFilePath = join(outDir, schemaFileRel);
    writeFileSync(schemaFilePath, JSON.stringify(schema, null, 2));

    out.sources[name] = sourceOut;
  }

  writeFileSync(
    join(outDir, "staticql.schema.json"),
    JSON.stringify(out, null, 2)
  );
}

async function run() {
  const [inputConfig, inputOut] = process.argv.slice(2);
  const configPath = path.resolve(
    process.cwd(),
    inputConfig || "staticql.config.ts"
  );
  const outDir = inputOut || "public";

  let staticql: StaticQL;

  try {
    const configModule = await import(pathToFileURL(configPath).href);
    staticql = await configModule.default();

    if (!staticql) {
      throw new Error(
        "staticql.config.ts が正しく defineStaticQL() を export していません。"
      );
    }
  } catch (err) {
    console.error("Config 読み込みに失敗しました");
    console.error(err);
    process.exit(1);
  }

  // schema.jsonとして保存
  try {
    createSchema(staticql.getConfig(), outDir);
  } catch (err) {
    console.error("スキーマ出力中にエラーが発生しました");
    console.error(err);
    process.exit(1);
  }
}

run();
