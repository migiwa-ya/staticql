#!/usr/bin/env node

import { pathToFileURL } from "url";
import { StaticQL } from "../src/StaticQL.js";

async function run() {
  const [inputConfig] = process.argv.slice(2);
  // Node.js/Workers両対応: 絶対パスならそのまま、相対パスならCWDから連結
  let configPath = inputConfig || "staticql.config.ts";
  if (
    !configPath.startsWith("/") &&
    typeof process !== "undefined" &&
    process.cwd
  ) {
    configPath = process.cwd() + "/" + configPath;
  }

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

  try {
    console.log("index.json を生成中...");
    await staticql!.saveIndexes();
    console.log("index.json を生成しました");
  } catch (err) {
    console.error("インデックス生成中にエラーが発生しました");
    console.error(err);
    process.exit(1);
  }
}

run();
