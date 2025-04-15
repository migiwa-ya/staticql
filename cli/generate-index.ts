#!/usr/bin/env tsx

import path from "path";
import { pathToFileURL } from "url";

async function run() {
  const [inputConfig, inputOut] = process.argv.slice(2);
  const configPath = path.resolve(
    process.cwd(),
    inputConfig || "staticql.config.ts"
  );
  const outputDir = path.resolve(process.cwd(), inputOut || "public/index");

  let db;

  try {
    const configModule = await import(pathToFileURL(configPath).href);
    db = configModule.default;

    if (!db || typeof db.index !== "function") {
      throw new Error(
        "staticql.config.ts が正しく defineContentDB() を export していません。"
      );
    }
  } catch (err) {
    console.error("Config 読み込みに失敗しました");
    console.error(err);
    process.exit(1);
  }

  try {
    console.log("index.json を生成中...");
    await db.saveIndexesTo(outputDir);
    console.log("index.json を生成しました");
  } catch (err) {
    console.error("インデックス生成中にエラーが発生しました");
    console.error(err);
    process.exit(1);
  }
}

run();
