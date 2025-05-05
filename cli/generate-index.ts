#!/usr/bin/env node

import path from "path";
import { existsSync, rmSync, readFileSync } from "fs";
import { defineStaticQL } from "../src/index.node.js";
import { StaticQL, StaticQLConfig } from "../src/StaticQL.js";
import { DiffEntry, Indexer } from "../src/Indexer.js";

async function run() {
  const { config, outputPath, isIncremental, diffFilePath } = await getArgs();
  const staticql: StaticQL = init(config, outputPath, isIncremental);

  if (isIncremental && diffFilePath) {
    await increment(staticql, diffFilePath);
  } else {
    await saveIndex(staticql);
  }
}

run();

function getArgs() {
  const args = process.argv.slice(2);
  let [configPath, outputPath] = args;
  const isIncremental = args.includes("--incremental");
  const diffFilePathArg = args.find((a) => a.startsWith("--diff-file="));
  const diffFilePath = diffFilePathArg ? diffFilePathArg.split("=")[1] : null;

  if (!configPath) {
    console.error("Error: 引数 'input' が必要です。");
    process.exit(1);
  }

  if (
    !configPath.startsWith("/") &&
    typeof process !== "undefined" &&
    process.cwd
  ) {
    configPath = process.cwd() + "/" + configPath;
  }

  if (isIncremental && !diffFilePath) {
    console.error(
      "--incremental モードでは --diff-file=xxx.json の指定が必要です"
    );
    process.exit(1);
  }

  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw);

  return { config, outputPath, isIncremental, diffFilePath };
}

function init(
  config: StaticQLConfig,
  outputPath: string,
  isIncremental: boolean
) {
  try {
    const staticql = defineStaticQL(config)({ baseDir: outputPath });

    // 出力前にインデックスディレクトリを削除（インクリメンタル時は削除しない）
    if (!isIncremental) {
      const indexDir = path.resolve(outputPath, Indexer.indexPrefix);

      if (existsSync(indexDir)) {
        rmSync(indexDir, { recursive: true, force: true });
      }
    }

    return staticql;
  } catch (err) {
    console.error("Config 読み込みに失敗しました");
    console.error(err);
    process.exit(1);
  }
}

async function saveIndex(staticql: StaticQL) {
  try {
    console.log("index.json を生成中...");
    await staticql.saveIndexes();
    console.log("index.json を生成しました");
  } catch (err) {
    console.error("インデックス生成中にエラーが発生しました");
    console.error(err);
    process.exit(1);
  }
}

async function increment(staticql: StaticQL, diffFilePath: string) {
  let diffEntries: DiffEntry[];

  try {
    const diffJson = readFileSync(path.resolve(diffFilePath), "utf-8");
    diffEntries = JSON.parse(diffJson);
  } catch (e) {
    console.error("差分ファイルの読み込みに失敗しました:", diffFilePath);
    process.exit(1);
  }

  try {
    console.log("インクリメンタルインデックス更新を実行します...");
    await staticql.getIndexer().updateIndexesForFiles(diffEntries);
    console.log("インクリメンタルインデックス更新が完了しました");
  } catch (err) {
    console.error("インデックス生成中にエラーが発生しました");
    console.error(err);
    process.exit(1);
  }
}
