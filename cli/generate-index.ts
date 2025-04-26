#!/usr/bin/env node

import { pathToFileURL } from "url";

async function run() {
  const [inputConfig, inputOut] = process.argv.slice(2);
  // Node.js/Workers両対応: 絶対パスならそのまま、相対パスならCWDから連結
  let configPath = inputConfig || "staticql.config.ts";
  if (
    !configPath.startsWith("/") &&
    typeof process !== "undefined" &&
    process.cwd
  ) {
    configPath = process.cwd() + "/" + configPath;
  }
  const outputDir = inputOut;

  let db;

  try {
    const configModule = await import(pathToFileURL(configPath).href);
    db = configModule.default;

    if (!db) {
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
