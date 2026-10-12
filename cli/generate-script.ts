#!/usr/bin/env node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { FsRepository } from "../src/repository/FsRepository.js";
import { Indexer } from "../src/Indexer.js";
import { SourceConfigResolver } from "../src/SourceConfigResolver.js";
import type { StaticQLConfig } from "../src/StaticQL.js";
import { ConsoleLogger } from "../src/logger/ConsoleLogger.js";

const logger = new ConsoleLogger("info");

interface CliArguments {
  configPath: string;
  dataDir: string;
  outputDir: string;
  manifest: boolean;
}

interface OutputDirectory {
  path: string;
  existed: boolean;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const config = await readConfig(args.configPath);
  const dataDir = path.resolve(args.dataDir);
  const outputDir = path.resolve(args.outputDir);

  const dataStats = await fs.stat(dataDir);
  if (!dataStats.isDirectory()) throw new Error("data_dir はディレクトリである必要があります");

  const validatedOutput = await validateOutputDirectory(dataDir, outputDir);
  const targets = await collectTargets(config, dataDir);
  if (targets.length === 0) throw new Error("対象ファイルがありません");

  validatePayloadDestinations(targets, args.manifest);
  const contents = await readTargets(targets, dataDir);
  await writePayloads(validatedOutput, contents, args.manifest);
  logger.info(`Generated ${contents.length} payload files${args.manifest ? " and manifest" : ""}.`);
}

function parseArguments(args: string[]): CliArguments {
  const positional: string[] = [];
  let manifest = false;
  for (const argument of args) {
    if (argument === "--manifest") {
      if (manifest) throw new Error("--manifest は一度だけ指定できます");
      manifest = true;
    } else if (argument.startsWith("-")) {
      throw new Error(`不明なオプション: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 3) {
    throw new Error("使用方法: staticql-gen-script <config_file> <data_dir> <output_dir> [--manifest]");
  }
  return {
    configPath: path.resolve(positional[0]!),
    dataDir: positional[1]!,
    outputDir: positional[2]!,
    manifest,
  };
}

async function readConfig(configPath: string): Promise<StaticQLConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(`config を読み込めません: ${configPath}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      typeof (parsed as { sources?: unknown }).sources !== "object" ||
      (parsed as { sources?: unknown }).sources === null ||
      Array.isArray((parsed as { sources?: unknown }).sources)) {
    throw new Error("config の sources はオブジェクトである必要があります");
  }
  return parsed as StaticQLConfig;
}

async function validateOutputDirectory(dataDir: string, outputDir: string): Promise<OutputDirectory> {
  const dataRealPath = await fs.realpath(dataDir);
  let outputExists = false;
  try {
    const stats = await fs.lstat(outputDir);
    outputExists = true;
    if (stats.isSymbolicLink()) throw new Error("出力先自体にシンボリックリンクは指定できません");
    if (!stats.isDirectory()) throw new Error("出力先はディレクトリである必要があります");
    if ((await fs.readdir(outputDir)).length > 0) throw new Error("出力先ディレクトリが空ではありません");
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }

  const outputRealPath = await canonicalizePath(outputDir);
  if (isAtOrWithin(dataRealPath, outputRealPath) || isAtOrWithin(outputRealPath, dataRealPath)) {
    throw new Error("出力先は data_dir と同じ場所、内側、または data_dir を含む場所には指定できません");
  }
  return { path: outputDir, existed: outputExists };
}

async function canonicalizePath(requestedPath: string): Promise<string> {
  let existingPath = path.resolve(requestedPath);
  const missingParts: string[] = [];
  while (true) {
    try {
      await fs.lstat(existingPath);
      const realExistingPath = await fs.realpath(existingPath);
      return path.resolve(realExistingPath, ...missingParts.reverse());
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = path.dirname(existingPath);
      if (parent === existingPath) throw error;
      missingParts.push(path.basename(existingPath));
      existingPath = parent;
    }
  }
}

function isAtOrWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function collectTargets(config: StaticQLConfig, dataDir: string): Promise<string[]> {
  const targets = new Set<string>();
  const indexRoot = path.join(dataDir, Indexer.indexPrefix);
  await collectIndexFiles(indexRoot, dataDir, targets);

  const repository = new FsRepository(dataDir);
  for (const source of Object.values(config.sources)) {
    if (!source || typeof source.pattern !== "string") throw new Error("config source の pattern が不正です");
    const listedPaths = await repository.listFiles(source.pattern);
    for (const listedPath of listedPaths) {
      const relativePath = toPosixPath(listedPath);
      if (!SourceConfigResolver.patternTest(source.pattern, relativePath)) continue;
      validateRelativePath(relativePath);
      const absolutePath = path.resolve(dataDir, relativePath);
      if (!isAtOrWithin(dataDir, absolutePath)) throw new Error(`data_dir の外を指す対象 path です: ${relativePath}`);
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink()) throw new Error(`シンボリックリンクは対象にできません: ${relativePath}`);
      if (!stats.isFile()) throw new Error(`通常ファイルではありません: ${relativePath}`);
      targets.add(relativePath);
    }
  }

  return [...targets].sort();
}

async function collectIndexFiles(indexRoot: string, dataDir: string, targets: Set<string>): Promise<void> {
  let rootStats;
  try {
    rootStats = await fs.lstat(indexRoot);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  if (rootStats.isSymbolicLink()) throw new Error(`index ディレクトリにシンボリックリンクは指定できません: ${indexRoot}`);
  if (!rootStats.isDirectory()) throw new Error(`index はディレクトリである必要があります: ${indexRoot}`);

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink()) throw new Error(`index 内のシンボリックリンクは対象にできません: ${absolutePath}`);
      if (stats.isDirectory()) {
        await walk(absolutePath);
      } else if (!stats.isFile()) {
        throw new Error(`index 内に通常ファイルでない項目があります: ${absolutePath}`);
      } else if (entry.name.endsWith(".jsonl") && !entry.name.endsWith(".gz")) {
        const relativePath = toPosixPath(path.relative(dataDir, absolutePath));
        validateRelativePath(relativePath);
        targets.add(relativePath);
      }
    }
  };
  await walk(indexRoot);
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function validateRelativePath(relativePath: string): void {
  if (!relativePath || path.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath) ||
      relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || relativePath.startsWith("../")) {
    throw new Error(`安全な相対 path ではありません: ${relativePath}`);
  }
}

function validatePayloadDestinations(targets: string[], manifest: boolean): void {
  const outputs = new Set<string>();
  for (const target of targets) {
    const outputPath = `${target}.js`;
    if (outputs.has(outputPath)) throw new Error(`payload 出力先が重複しています: ${outputPath}`);
    outputs.add(outputPath);
    if (manifest && outputPath === "manifest.js") {
      throw new Error("source path manifest の payload が manifest.js と衝突します");
    }
  }
}

async function readTargets(targets: string[], dataDir: string): Promise<Array<{ path: string; content: string }>> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const contents: Array<{ path: string; content: string }> = [];
  for (const target of targets) {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(path.join(dataDir, target));
    } catch (error) {
      throw new Error(`対象ファイルを読み込めません: ${target}`, { cause: error });
    }
    try {
      contents.push({ path: target, content: decoder.decode(bytes) });
    } catch (error) {
      throw new Error(`対象ファイルを UTF-8 としてデコードできません: ${target}`, { cause: error });
    }
  }
  return contents;
}

function jsLiteral(value: string | string[]): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

async function writePayloads(
  output: OutputDirectory,
  contents: Array<{ path: string; content: string }>,
  manifest: boolean,
): Promise<void> {
  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "staticql-gen-script-"));
  try {
    for (const item of contents) {
      const stagedPath = path.join(stageDir, `${item.path}.js`);
      await fs.mkdir(path.dirname(stagedPath), { recursive: true });
      await fs.writeFile(stagedPath, `globalThis.__STATICQL_SCRIPT__.register(${jsLiteral(item.path)},${jsLiteral(item.content)});\n`, "utf8");
    }
    if (manifest) {
      const stagedManifest = path.join(stageDir, "manifest.js");
      await fs.writeFile(stagedManifest, `globalThis.__STATICQL_SCRIPT__.registerManifest(${jsLiteral(contents.map(({ path: itemPath }) => itemPath))});\n`, "utf8");
    }

    try {
      await fs.mkdir(output.path, { recursive: true });
      for (const item of contents) {
        const relativeOutputPath = `${item.path}.js`;
        const stagedPath = path.join(stageDir, relativeOutputPath);
        const outputPath = path.join(output.path, relativeOutputPath);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.cp(stagedPath, outputPath, { errorOnExist: true, force: false });
      }
      if (manifest) {
        await fs.cp(path.join(stageDir, "manifest.js"), path.join(output.path, "manifest.js"), {
          errorOnExist: true,
          force: false,
        });
      }
    } catch (error) {
      try {
        if (!output.existed) {
          await fs.rm(output.path, { recursive: true, force: true });
        } else {
          await clearDirectory(output.path);
        }
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "payload コピーに失敗し、出力先のロールバックにも失敗しました");
      }
      throw error;
    }
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
  }
}

async function clearDirectory(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory)) {
    await fs.rm(path.join(directory, entry), { recursive: true, force: true });
  }
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
