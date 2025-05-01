#!/usr/bin/env node

import { pathToFileURL } from "url";
import { StaticQL } from "../src/StaticQL.js";
import { existsSync, rmSync, readFileSync } from "fs";
import { getIndexDir } from "../src/utils/path.js";
import { DiffEntry } from "../src/Indexer.js";
import path from "path";

async function run() {
  const args = process.argv.slice(2);
  const [inputConfig] = args;
  // Node.js/Workers両対応: 絶対パスならそのまま、相対パスならCWDから連結
  let configPath = inputConfig || "staticql.config.ts";
  if (
    !configPath.startsWith("/") &&
    typeof process !== "undefined" &&
    process.cwd
  ) {
    configPath = process.cwd() + "/" + configPath;
  }

  // コマンドライン引数から --incremental, --diff-file をパース
  const isIncremental = args.includes("--incremental");
  const diffFileArg = args.find((a) => a.startsWith("--diff-file="));
  const diffFile = diffFileArg ? diffFileArg.split("=")[1] : null;

  let staticql: StaticQL;

  try {
    const configModule = await import(pathToFileURL(configPath).href);
    staticql = await configModule.default();

    if (!staticql) {
      throw new Error(
        "staticql.config.ts が正しく defineStaticQL() を export していません。"
      );
    }

    // 出力前にインデックスディレクトリを削除（インクリメンタル時は削除しない）
    if (!isIncremental) {
      const outputDir = staticql.getConfig().storage.output.replace(/\/$/, "");
      const indexDir = getIndexDir(outputDir);
      try {
        if (existsSync(indexDir)) {
          rmSync(indexDir, { recursive: true, force: true });
        }
      } catch (e) {
        // ignore
      }
    }
  } catch (err) {
    console.error("Config 読み込みに失敗しました");
    console.error(err);
    process.exit(1);
  }

  try {
    if (isIncremental) {
      if (!diffFile) {
        console.error("--incremental モードでは --diff-file=xxx.json の指定が必要です");
        process.exit(1);
      }
      let diffEntries: DiffEntry[];
      try {
        const diffJson = readFileSync(path.resolve(diffFile), "utf-8");
        diffEntries = JSON.parse(diffJson);
      } catch (e) {
        console.error("差分ファイルの読み込みに失敗しました:", diffFile);
        process.exit(1);
      }
      console.log("インクリメンタルインデックス更新を実行します...");
      await staticql.getIndexer().updateIndexesForFiles(
        staticql.getConfig().storage.output,
        diffEntries
      );
      console.log("インクリメンタルインデックス更新が完了しました");
    } else {
      console.log("index.json を生成中...");
      await staticql!.saveIndexes();
      console.log("index.json を生成しました");
    }
  } catch (err) {
    console.error("インデックス生成中にエラーが発生しました");
    console.error(err);
    process.exit(1);
  }
}

run();
