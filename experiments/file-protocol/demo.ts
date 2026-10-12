import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { defineStaticQL, type StaticQLConfig } from "../../src/index.js";
import type { StaticQL } from "../../src/StaticQL.js";
import type { SourceRecord } from "../../src/types.js";
import { FsRepository } from "../../src/repository/FsRepository.js";

export const BOOTSTRAP_LOAD_FAILURE_NOTE = "file:// では、ファイルが存在しない場合と読み取れない場合を区別できません";

export interface QueryInputs {
  name: string;
  nameUpper: string;
  herbSlug: string;
}

export interface DemoExpected {
  inputs: QueryInputs;
  results: Record<string, unknown>;
  logicalFileCount: number;
}

export interface DemoGeneration {
  outDir: string;
  expected: DemoExpected;
  logicalPaths: string[];
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const contentDir = path.join(repoRoot, "tests/content");
const configPath = path.join(repoRoot, "tests/staticql.config.json");
const defaultOutDir = path.join(repoRoot, ".cache/file-protocol-demo");

export async function generateDemo(outDir = defaultOutDir): Promise<DemoGeneration> {
  const safeOutDir = await validateOutputDirectory(outDir);
  await fs.mkdir(safeOutDir, { recursive: true });

  const stageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "staticql-file-protocol-stage-"));
  try {
    const config = await loadConfig();
    const datasetRoot = path.join(stageRoot, "dataset");
    await fs.mkdir(datasetRoot, { recursive: true });
    await fs.cp(contentDir, path.join(datasetRoot, "content"), { recursive: true });

    const staticql = defineStaticQL(config)({ repository: new FsRepository(datasetRoot) });
    await staticql.saveIndexes({
      "herbs.nameUpper": (record) => String(record.name ?? "").toUpperCase(),
    });

    const inputs: QueryInputs = {
      name: "ゴボウ",
      nameUpper: "ゴボウ",
      herbSlug: "centella-asiatica",
    };
    const expectedResults = await runExpectedQueries(staticql, inputs);
    const files = await listFiles(datasetRoot);
    const expected: DemoExpected = {
      inputs,
      results: expectedResults,
      logicalFileCount: files.length,
    };

    for (const relativePath of files) {
      const content = await fs.readFile(path.join(datasetRoot, relativePath), "utf8");
      const payloadPath = path.join(safeOutDir, `${relativePath}.js`);
      await fs.mkdir(path.dirname(payloadPath), { recursive: true });
      await fs.writeFile(
        payloadPath,
        `window.__sq.register(${JSON.stringify(relativePath)},${JSON.stringify(content)});\n`,
        "utf8",
      );
    }

    await fs.writeFile(
      path.join(safeOutDir, "manifest.js"),
      `window.__sq.registerManifest(${JSON.stringify(files)});\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(safeOutDir, "expected.js"),
      `window.__sqExpected = ${JSON.stringify(expected)};\n`,
      "utf8",
    );

    await build({
      absWorkingDir: repoRoot,
      entryPoints: [path.join(scriptDir, "src/demo-entry.ts")],
      outfile: path.join(safeOutDir, "demo-entry.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "es2020",
    });
    await writeIndexHtml(safeOutDir, config);

    return { outDir: safeOutDir, expected, logicalPaths: files };
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}

async function validateOutputDirectory(requestedPath: string): Promise<string> {
  const repoRealPath = await fs.realpath(repoRoot);
  const resolved = path.resolve(repoRoot, requestedPath);
  if (resolved === repoRoot || resolved === repoRealPath) {
    throw new Error("出力先にリポジトリルートは指定できません");
  }

  const lexicalRelative = path.relative(repoRoot, resolved);
  if (!isInside(lexicalRelative)) {
    throw new Error("出力先はリポジトリ内に指定してください");
  }

  let existingPath = resolved;
  let existingStats;
  while (true) {
    try {
      existingStats = await fs.lstat(existingPath);
      break;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = path.dirname(existingPath);
      if (parent === existingPath) throw error;
      existingPath = parent;
    }
  }

  const existingRealPath = await fs.realpath(existingPath);
  if (!isInside(path.relative(repoRealPath, existingRealPath))) {
    throw new Error("出力先の既存祖先がリポジトリ外を指しています");
  }

  const outDirExists = existingPath === resolved;
  if (outDirExists && existingStats.isSymbolicLink()) {
    throw new Error("出力先自体にシンボリックリンクは指定できません");
  }
  if (outDirExists && !existingStats.isDirectory()) {
    throw new Error("出力先はディレクトリである必要があります");
  }

  const realOutputPath = outDirExists ? existingRealPath : path.resolve(existingRealPath, path.relative(existingPath, resolved));
  if (realOutputPath === repoRealPath || !isInside(path.relative(repoRealPath, realOutputPath))) {
    throw new Error("出力先はリポジトリ内のルート以外に指定してください");
  }

  if (outDirExists && (await fs.readdir(resolved)).length > 0) {
    throw new Error("出力先ディレクトリが空ではありません。内容を確認して手動で削除してから再実行してください");
  }
  return resolved;
}

function isInside(relativePath: string): boolean {
  return relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function loadConfig(): Promise<StaticQLConfig> {
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as StaticQLConfig;
  config.sources.herbs!.customIndex = { nameUpper: {} };
  return config;
}

async function runExpectedQueries(staticql: StaticQL, inputs: QueryInputs) {
  const herbsByName = await staticql.from<SourceRecord, string>("herbs").where("name", "eq", inputs.name).exec();
  const herbsByCustomIndex = await staticql.from<SourceRecord, string>("herbs").where("nameUpper", "eq", inputs.nameUpper).exec();
  const recipesByHerb = await staticql.from<SourceRecord, string>("recipes").join("herbs")
    .where("herbs.slug", "in", [inputs.herbSlug]).exec();
  return {
    "herbs-name": herbsByName,
    "herbs-nameUpper": herbsByCustomIndex,
    "recipes-herbs": recipesByHerb,
  };
}

async function listFiles(root: string, base = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(absolute, base));
    else if (entry.isFile()) result.push(path.relative(base, absolute).split(path.sep).join("/"));
  }
  return result.sort();
}

async function writeIndexHtml(outDir: string, config: StaticQLConfig): Promise<void> {
  const configAttribute = escapeAttribute(JSON.stringify(config));
  const html = `<!doctype html>
<html lang="ja" data-config="${configAttribute}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>StaticQL file:// デモ</title>
  <style>
    body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; color: #202124; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #c7c7c7; padding: .6rem; text-align: left; vertical-align: top; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: .25rem 0; }
    .error { color: #b00020; font-weight: 700; }
    button { font: inherit; padding: .45rem .9rem; }
  </style>
</head>
<body>
  <main>
    <h1>StaticQL file:// デモ</h1>
    <p id="environment"></p>
    <p>このページは file:// から静的ファイルを読み込みます。各クエリで取得したファイルと FsRepository の結果を確認できます。</p>
    <button id="run" type="button">実行</button>
    <p id="status" data-status="ready" aria-live="polite">「実行」を押してください。</p>
    <p id="boot-error" class="error" role="alert"></p>
    <table>
      <thead><tr><th>クエリ</th><th>結果 (slug)</th><th>FsRepository と一致</th><th>取得ファイル</th></tr></thead>
      <tbody id="results"></tbody>
    </table>
  </main>
  <script src="./expected.js" onerror="document.getElementById('boot-error').textContent='expected.js が読めない (${BOOTSTRAP_LOAD_FAILURE_NOTE})';"></script>
  <script src="./demo-entry.js" onerror="document.getElementById('boot-error').textContent='demo-entry.js が読めない (${BOOTSTRAP_LOAD_FAILURE_NOTE})';"></script>
</body>
</html>
`;
  await fs.writeFile(path.join(outDir, "index.html"), html, "utf8");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function main(): Promise<void> {
  if (process.argv.length > 3) throw new Error("使用方法: npx --no-install tsx experiments/file-protocol/demo.ts [outDir]");
  const target = process.argv[2] ? path.resolve(repoRoot, process.argv[2]) : defaultOutDir;
  const result = await generateDemo(target);
  console.log(`デモを生成しました: ${path.join(result.outDir, "index.html")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
