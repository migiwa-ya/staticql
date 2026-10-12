import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineStaticQL, type StaticQLConfig } from "../src/index.js";
import { SourceConfigResolver } from "../src/SourceConfigResolver.js";
import { FsRepository } from "../src/repository/FsRepository.js";
import { ScriptRepository } from "../src/repository/ScriptRepository.js";
import staticqlConfig from "./staticql.config.json";
import type { HerbsRecord, RecipesRecord } from "./staticql-types.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const scriptCli = path.join(repoRoot, "cli/generate-script.ts");
const indexCli = path.join(repoRoot, "cli/generate-index.ts");
const configSource = path.join(testDir, "staticql.config.json");
const contentSource = path.join(testDir, "content");
const roots: string[] = [];

interface Fixture {
  root: string;
  dataDir: string;
  configPath: string;
  outputDir: string;
}

interface FakeScript {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.__STATICQL_SCRIPT__;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-gen-script-test-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.cpSync(contentSource, path.join(dataDir, "content"), { recursive: true });
  const configPath = path.join(root, "staticql.config.json");
  fs.copyFileSync(configSource, configPath);
  const result = spawnSync("tsx", [indexCli, configPath, dataDir], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return { root, dataDir, configPath, outputDir: path.join(root, "payload") };
}

function runCli(fixture: Fixture, extraArgs: string[] = [], overrides: { configPath?: string; dataDir?: string; outputDir?: string } = {}) {
  return spawnSync("tsx", [
    scriptCli,
    overrides.configPath ?? fixture.configPath,
    overrides.dataDir ?? fixture.dataDir,
    overrides.outputDir ?? fixture.outputDir,
    ...extraArgs,
  ], { encoding: "utf8" });
}

function listFiles(root: string, base = root): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return listFiles(absolute, base);
    if (entry.isFile()) return [path.relative(base, absolute).split(path.sep).join("/")];
    return [];
  }).sort();
}

function expectedTargets(dataDir: string): string[] {
  const allPaths = listFiles(dataDir);
  const indexPaths = allPaths.filter((entry) => entry.startsWith("index/") && entry.endsWith(".jsonl") && !entry.endsWith(".gz"));
  const patterns = Object.values(staticqlConfig.sources).map((source) => source.pattern);
  const sourcePaths = allPaths.filter((entry) => patterns.some((pattern) => SourceConfigResolver.patternTest(pattern, entry)));
  return [...new Set([...indexPaths, ...sourcePaths])].sort();
}

function snapshot(pathname: string): unknown {
  let stats;
  try {
    stats = fs.lstatSync(pathname);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  if (stats.isSymbolicLink()) return { symlink: fs.readlinkSync(pathname) };
  if (stats.isDirectory()) {
    return Object.fromEntries(fs.readdirSync(pathname).sort().map((name) => [name, snapshot(path.join(pathname, name))]));
  }
  if (stats.isFile()) return fs.readFileSync(pathname).toString("base64");
  return { mode: stats.mode };
}

function executeRegistrationScripts(outputDir: string): { registrations: Map<string, string>; manifest?: string[] } {
  const registrations = new Map<string, string>();
  let manifest: string[] | undefined;
  for (const outputPath of listFiles(outputDir).filter((entry) => entry.endsWith(".js"))) {
    const code = fs.readFileSync(path.join(outputDir, outputPath), "utf8");
    const api = {
      register(relativePath: string, content: string) { registrations.set(relativePath, content); },
      registerManifest(paths: string[]) { manifest = paths; },
    };
    vm.runInNewContext(code, { __STATICQL_SCRIPT__: api });
  }
  return { registrations, manifest };
}

function installPayloadBrowser(outputDir: string, baseUrl: string): void {
  const scripts: FakeScript[] = [];
  let currentScript: FakeScript | null = null;
  const payloads = new Map<string, string>();
  for (const outputPath of listFiles(outputDir).filter((entry) => entry.endsWith(".js"))) {
    const code = fs.readFileSync(path.join(outputDir, outputPath), "utf8");
    const relativePath = outputPath.slice(0, -3);
    payloads.set(new URL(`${relativePath}.js`, baseUrl).href, code);
  }
  vi.stubGlobal("document", {
    get currentScript() { return currentScript; },
    createElement: () => ({ src: "", async: false, onload: null, onerror: null }) as FakeScript,
    head: {
      appendChild(script: FakeScript) {
        scripts.push(script);
        const code = payloads.get(script.src);
        if (code === undefined) {
          script.onerror?.();
          return script;
        }
        currentScript = script;
        vm.runInThisContext(code);
        currentScript = null;
        script.onload?.();
        return script;
      },
    },
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  expect(scripts).toHaveLength(0);
}

describe("staticql-gen-script CLI", () => {
  it("emits only matching source files and non-gzip indexes with UTF-8 faithful JS registrations and a manifest", () => {
    const fixture = makeFixture();
    fs.mkdirSync(path.join(fixture.dataDir, "content/herbs/sub"), { recursive: true });
    fs.writeFileSync(path.join(fixture.dataDir, "content/herbs/notes.txt"), "not a source match", "utf8");
    fs.writeFileSync(path.join(fixture.dataDir, "content/herbs/sub/x.md"), "nested source excluded by *.md", "utf8");
    fs.writeFileSync(path.join(fixture.dataDir, "staticql-manifest.json"), "unrelated", "utf8");
    const literalContent = "\uFEFFfirst\u2028second\u2029third </script>\n\"quoted\"";
    const literalPath = path.join(fixture.dataDir, "content/herbs/payload-literals.md");
    fs.writeFileSync(literalPath, literalContent, "utf8");

    const result = runCli(fixture, ["--manifest"]);
    expect(result.status, result.stderr).toBe(0);

    const expected = expectedTargets(fixture.dataDir);
    const outputPaths = listFiles(fixture.outputDir);
    expect(outputPaths).toEqual([...expected.map((entry) => `${entry}.js`), "manifest.js"].sort());
    expect(outputPaths).not.toContain("content/herbs/notes.txt.js");
    expect(outputPaths).not.toContain("content/herbs/sub/x.md.js");
    expect(outputPaths).not.toContain("staticql-manifest.json.js");

    const { registrations, manifest } = executeRegistrationScripts(fixture.outputDir);
    expect([...registrations.keys()].sort()).toEqual(expected);
    for (const relativePath of expected) {
      const original = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(path.join(fixture.dataDir, relativePath)));
      expect(registrations.get(relativePath)).toBe(original);
    }
    expect(registrations.get("content/herbs/payload-literals.md")).toBe(literalContent);
    expect(manifest).toEqual(expected);
  });

  it("loads generated payloads through ScriptRepository and matches FsRepository query results", async () => {
    const fixture = makeFixture();
    const generated = runCli(fixture);
    expect(generated.status, generated.stderr).toBe(0);

    const config = staticqlConfig as StaticQLConfig;
    const fsStaticql = defineStaticQL(config)({ repository: new FsRepository(fixture.dataDir) });
    const browserBase = "file:///staticql-payload/";
    installPayloadBrowser(fixture.outputDir, browserBase);
    const scriptRepository = new ScriptRepository(browserBase);
    scriptRepository.setResolver(new SourceConfigResolver(config.sources));
    const scriptStaticql = defineStaticQL(config)({ repository: scriptRepository });

    const [fsHerbs, scriptHerbs] = await Promise.all([
      fsStaticql.from<HerbsRecord, string>("herbs").where("name", "eq", "ゴボウ").exec(),
      scriptStaticql.from<HerbsRecord, string>("herbs").where("name", "eq", "ゴボウ").exec(),
    ]);
    expect(scriptHerbs.data.map((record) => record.slug).sort()).toEqual(fsHerbs.data.map((record) => record.slug).sort());

    const [fsRecipes, scriptRecipes] = await Promise.all([
      fsStaticql.from<RecipesRecord, string>("recipes").join("herbs").where("herbs.slug", "in", ["centella-asiatica"]).exec(),
      scriptStaticql.from<RecipesRecord, string>("recipes").join("herbs").where("herbs.slug", "in", ["centella-asiatica"]).exec(),
    ]);
    expect(scriptRecipes.data.map((record) => record.slug).sort()).toEqual(fsRecipes.data.map((record) => record.slug).sort());
  });

  it("does not emit manifest.js unless --manifest is supplied", () => {
    const fixture = makeFixture();
    const result = runCli(fixture);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(fixture.outputDir, "manifest.js"))).toBe(false);
  });

  it("rejects manifest payload collisions and allows the source payload without --manifest", () => {
    const fixture = makeFixture();
    const specialConfigPath = path.join(fixture.root, "manifest.config.json");
    fs.writeFileSync(specialConfigPath, JSON.stringify({ sources: { manifest: { pattern: "manifest" } } }), "utf8");
    fs.writeFileSync(path.join(fixture.dataDir, "manifest"), "source manifest payload", "utf8");

    const rejected = runCli(fixture, ["--manifest"], { configPath: specialConfigPath });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("衝突");
    expect(fs.existsSync(fixture.outputDir)).toBe(false);

    const accepted = runCli(fixture, [], { configPath: specialConfigPath });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(fs.readFileSync(path.join(fixture.outputDir, "manifest.js"), "utf8")).toContain("source manifest payload");
  });

  it("rejects symlinks encountered anywhere under index without creating output", () => {
    for (const kind of ["file", "directory"] as const) {
      const fixture = makeFixture();
      const linkPath = path.join(fixture.dataDir, "index", kind === "file" ? "link.jsonl" : "linked-dir");
      const target = kind === "file"
        ? path.join(fixture.dataDir, "index", "herbs.slug", "_index.jsonl")
        : path.join(fixture.root, "external-index-dir");
      if (kind === "directory") fs.mkdirSync(target);
      fs.symlinkSync(target, linkPath, kind === "directory" ? "dir" : "file");

      const result = runCli(fixture);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("シンボリックリンク");
      expect(fs.existsSync(fixture.outputDir)).toBe(false);
    }
  });

  it("rejects missing arguments, unreadable or invalid config, invalid UTF-8, and an empty target set without partial output", () => {
    const fixture = makeFixture();
    const shortArgs = spawnSync("tsx", [scriptCli], { encoding: "utf8" });
    expect(shortArgs.status).not.toBe(0);
    expect(shortArgs.stderr).toContain("使用方法");

    const unknownFlag = spawnSync("tsx", [scriptCli, fixture.configPath, fixture.dataDir, fixture.outputDir, "--unknown"], { encoding: "utf8" });
    expect(unknownFlag.status).not.toBe(0);
    expect(unknownFlag.stderr).toContain("不明なオプション");

    const extraPosition = spawnSync("tsx", [scriptCli, fixture.configPath, fixture.dataDir, fixture.outputDir, "extra"], { encoding: "utf8" });
    expect(extraPosition.status).not.toBe(0);
    expect(extraPosition.stderr).toContain("使用方法");

    const missingConfig = runCli(fixture, [], { configPath: path.join(fixture.root, "missing.json") });
    expect(missingConfig.status).not.toBe(0);
    expect(missingConfig.stderr).toContain("config を読み込めません");
    expect(fs.existsSync(fixture.outputDir)).toBe(false);

    const invalidConfigPath = path.join(fixture.root, "invalid.json");
    fs.writeFileSync(invalidConfigPath, "{", "utf8");
    const invalidConfig = runCli(fixture, [], { configPath: invalidConfigPath });
    expect(invalidConfig.status).not.toBe(0);
    expect(invalidConfig.stderr).toContain("config を読み込めません");
    expect(fs.existsSync(fixture.outputDir)).toBe(false);

    const invalidUtf8Path = path.join(fixture.dataDir, "content/herbs/arctium-lappa.md");
    fs.writeFileSync(invalidUtf8Path, Buffer.from([0xff, 0xfe]));
    const invalidUtf8 = runCli(fixture);
    expect(invalidUtf8.status).not.toBe(0);
    expect(invalidUtf8.stderr).toContain("arctium-lappa.md");
    expect(fs.existsSync(fixture.outputDir)).toBe(false);

    const emptyRoot = path.join(fixture.root, "empty-data");
    fs.mkdirSync(emptyRoot);
    const emptyConfig = path.join(fixture.root, "empty.config.json");
    fs.writeFileSync(emptyConfig, JSON.stringify({ sources: {} }), "utf8");
    const emptyOutput = path.join(fixture.root, "empty-output");
    const emptyRun = runCli(fixture, [], { configPath: emptyConfig, dataDir: emptyRoot, outputDir: emptyOutput });
    expect(emptyRun.status).not.toBe(0);
    expect(emptyRun.stderr).toContain("対象ファイルがありません");
    expect(fs.existsSync(emptyOutput)).toBe(false);

    const existingEmptyOutput = path.join(fixture.root, "existing-empty-output");
    fs.mkdirSync(existingEmptyOutput);
    const emptyRunExisting = runCli(fixture, [], { configPath: emptyConfig, dataDir: emptyRoot, outputDir: existingEmptyOutput });
    expect(emptyRunExisting.status).not.toBe(0);
    expect(fs.readdirSync(existingEmptyOutput)).toEqual([]);
  });

  it.each([
    ["same", true],
    ["inside", false],
    ["contains", true],
  ] as const)("rejects output that is %s the data directory without changing data", (caseName, outputExists) => {
    const fixture = makeFixture();
    const outputDir = caseName === "same"
      ? fixture.dataDir
      : caseName === "inside"
        ? path.join(fixture.dataDir, "payload")
        : fixture.root;
    const before = snapshot(fixture.dataDir);
    const outputBefore = snapshot(outputDir);
    const result = runCli(fixture, [], { outputDir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("出力先");
    expect(snapshot(fixture.dataDir)).toEqual(before);
    expect(snapshot(outputDir)).toEqual(outputBefore);
    expect(fs.existsSync(outputDir)).toBe(outputExists);
  });

  it("rejects non-directory and non-empty destinations without changing them", () => {
    const fixture = makeFixture();
    const fileOutput = path.join(fixture.root, "output-file");
    fs.writeFileSync(fileOutput, "preserve", "utf8");
    const fileBefore = snapshot(fileOutput);
    const fileResult = runCli(fixture, [], { outputDir: fileOutput });
    expect(fileResult.status).not.toBe(0);
    expect(fileResult.stderr).toContain("ディレクトリ");
    expect(snapshot(fileOutput)).toEqual(fileBefore);

    const nonEmptyOutput = path.join(fixture.root, "non-empty-output");
    fs.mkdirSync(nonEmptyOutput);
    fs.writeFileSync(path.join(nonEmptyOutput, "old.js"), "old payload", "utf8");
    const before = snapshot(nonEmptyOutput);
    const nonEmptyResult = runCli(fixture, [], { outputDir: nonEmptyOutput });
    expect(nonEmptyResult.status).not.toBe(0);
    expect(nonEmptyResult.stderr).toContain("空ではありません");
    expect(snapshot(nonEmptyOutput)).toEqual(before);
  });

  it("rejects output symlinks and a symlinked parent into data_dir without writing through them", () => {
    const fixture = makeFixture();
    const linkTarget = path.join(fixture.root, "empty-target");
    fs.mkdirSync(linkTarget);
    const outputLink = path.join(fixture.root, "output-link");
    fs.symlinkSync(linkTarget, outputLink, "dir");
    const linkedResult = runCli(fixture, [], { outputDir: outputLink });
    expect(linkedResult.status).not.toBe(0);
    expect(linkedResult.stderr).toContain("シンボリックリンク");
    expect(fs.readdirSync(linkTarget)).toEqual([]);

    const danglingTarget = path.join(fixture.root, "missing-target");
    const danglingLink = path.join(fixture.root, "dangling-output-link");
    fs.symlinkSync(danglingTarget, danglingLink, "dir");
    const danglingResult = runCli(fixture, [], { outputDir: danglingLink });
    expect(danglingResult.status).not.toBe(0);
    expect(danglingResult.stderr).toContain("シンボリックリンク");
    expect(fs.lstatSync(danglingLink).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(danglingTarget)).toBe(false);

    const parentLink = path.join(fixture.root, "data-alias");
    fs.symlinkSync(fixture.dataDir, parentLink, "dir");
    const before = snapshot(fixture.dataDir);
    const parentLinkResult = runCli(fixture, [], { outputDir: path.join(parentLink, "payload") });
    expect(parentLinkResult.status).not.toBe(0);
    expect(parentLinkResult.stderr).toContain("出力先");
    expect(snapshot(fixture.dataDir)).toEqual(before);
  });

  it("validates the package bin and executable shebang", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { bin: Record<string, string> };
    expect(packageJson.bin["staticql-gen-script"]).toBe("./dist/cli/generate-script.js");
    expect(fs.readFileSync(scriptCli, "utf8").split(/\r?\n/, 1)[0]).toBe("#!/usr/bin/env node");
  });
});
