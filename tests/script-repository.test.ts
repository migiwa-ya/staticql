import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineStaticQL, type StaticQLConfig } from "../src/index.js";
import { SourceConfigResolver } from "../src/SourceConfigResolver.js";
import staticqlConfig from "./staticql.config.json";
import { FsRepository } from "../src/repository/FsRepository.js";
import { NotFoundError } from "../src/repository/errors.js";
import { ScriptRepository } from "../src/repository/ScriptRepository.js";

type FakeScript = HTMLScriptElement & {
  onload: (() => void) | null;
  onerror: (() => void) | null;
};

interface BrowserHarness {
  scripts: FakeScript[];
  errors: Set<(event: ErrorEvent) => void>;
  setCurrentScript(script: FakeScript | null): void;
  onAppend?: (script: FakeScript) => void;
}

let browser: BrowserHarness;
const temporaryRoots: string[] = [];

function installBrowserHarness(): BrowserHarness {
  const scripts: FakeScript[] = [];
  const errors = new Set<(event: ErrorEvent) => void>();
  let currentScript: FakeScript | null = null;
  const harness: BrowserHarness = {
    scripts,
    errors,
    setCurrentScript(script) {
      currentScript = script;
    },
  };

  vi.stubGlobal("document", {
    get currentScript() {
      return currentScript;
    },
    createElement: vi.fn(() => ({ src: "", async: false, onload: null, onerror: null }) as FakeScript),
    head: {
      appendChild: vi.fn((script: FakeScript) => {
        scripts.push(script);
        harness.onAppend?.(script);
        return script;
      }),
    },
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn((type: string, listener: (event: ErrorEvent) => void) => {
      if (type === "error") errors.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: ErrorEvent) => void) => {
      if (type === "error") errors.delete(listener);
    }),
  });
  return harness;
}

function registerAndLoad(script: FakeScript, path: string, content: string): void {
  browser.setCurrentScript(script);
  globalThis.__STATICQL_SCRIPT__!.register(path, content);
  browser.setCurrentScript(null);
  script.onload!();
}

function registerManifestAndLoad(script: FakeScript, paths: string[]): void {
  browser.setCurrentScript(script);
  globalThis.__STATICQL_SCRIPT__!.registerManifest(paths);
  browser.setCurrentScript(null);
  script.onload!();
}

function failToLoad(script: FakeScript): void {
  script.onerror!();
}

function dispatchScriptError(script: FakeScript, message = "syntax error"): void {
  const event = { filename: script.src, message } as ErrorEvent;
  browser.setCurrentScript(script);
  for (const listener of browser.errors) listener(event);
  browser.setCurrentScript(null);
  script.onload!();
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function recursivelyListFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    return entry.isDirectory() ? recursivelyListFiles(fullPath) : [fullPath];
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.__STATICQL_SCRIPT__;
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  browser = installBrowserHarness();
});

describe("ScriptRepository", () => {
  it("reads a registered payload and reports it as present", async () => {
    const repository = new ScriptRepository("file:///data/");
    const content = repository.readFile("herbs/a.md");
    registerAndLoad(browser.scripts[0]!, "herbs/a.md", "herb content");

    await expect(content).resolves.toBe("herb content");
    await expect(repository.exists("herbs/a.md")).resolves.toBe(true);
  });

  it("treats a missing payload as absent in lenient mode", async () => {
    const repository = new ScriptRepository("file:///data/");
    const content = repository.readFile("missing.md");
    failToLoad(browser.scripts[0]!);

    await expect(content).rejects.toBeInstanceOf(NotFoundError);
    const exists = repository.exists("other-missing.md");
    failToLoad(browser.scripts[1]!);
    await expect(exists).resolves.toBe(false);
  });

  it("loads a manifest once and avoids requesting paths absent from it", async () => {
    const repository = new ScriptRepository("file:///data/", { absence: "manifest" });
    const missing = repository.readFile("missing.md");
    registerManifestAndLoad(browser.scripts[0]!, ["present.md"]);

    await expect(missing).rejects.toBeInstanceOf(NotFoundError);
    expect(browser.scripts).toHaveLength(1);
    await expect(repository.exists("missing.md")).resolves.toBe(false);
    expect(browser.scripts).toHaveLength(1);
  });

  it("propagates a failed load for a path listed in the manifest", async () => {
    const repository = new ScriptRepository("file:///data/", { absence: "manifest" });
    const content = repository.readFile("present.md");
    registerManifestAndLoad(browser.scripts[0]!, ["present.md"]);
    await flushMicrotasks();
    failToLoad(browser.scripts[1]!);

    await expect(content).rejects.toThrow("Existing manifest path failed to load");
    await expect(content).rejects.not.toBeInstanceOf(NotFoundError);

    const existence = repository.exists("present.md");
    await flushMicrotasks();
    failToLoad(browser.scripts[2]!);
    await expect(existence).rejects.toThrow("Existing manifest path failed to load");
    await expect(existence).rejects.not.toBeInstanceOf(NotFoundError);
  });

  it("propagates a script error instead of treating it as absence", async () => {
    const repository = new ScriptRepository("file:///data/");
    const content = repository.readFile("broken.js");
    dispatchScriptError(browser.scripts[0]!);

    await expect(content).rejects.toThrow("syntax error");
    await expect(content).rejects.not.toBeInstanceOf(NotFoundError);
  });

  it("rejects exists on a script error instead of reporting absence", async () => {
    const repository = new ScriptRepository("file:///data/");
    const existence = repository.exists("broken.js");
    dispatchScriptError(browser.scripts[0]!);

    await expect(existence).rejects.toThrow("syntax error");
    await expect(existence).rejects.not.toBeInstanceOf(NotFoundError);
  });

  it("rejects a script that loads without registering the requested path", async () => {
    const repository = new ScriptRepository("file:///data/");
    const content = repository.readFile("unregistered.md");
    browser.scripts[0]!.onload!();

    await expect(content).rejects.toThrow("did not register unregistered.md");
  });

  it("coalesces concurrent reads and caches a loaded path", async () => {
    const repository = new ScriptRepository("file:///data/");
    const first = repository.readFile("same.md");
    const second = repository.readFile("same.md");
    expect(browser.scripts).toHaveLength(1);
    registerAndLoad(browser.scripts[0]!, "same.md", "shared content");

    await expect(Promise.all([first, second])).resolves.toEqual(["shared content", "shared content"]);
    await expect(repository.readFile("same.md")).resolves.toBe("shared content");
    expect(browser.scripts).toHaveLength(1);
  });

  it.each(["old-first", "new-first"] as const)(
    "routes overlapping payload registrations to their owning instance (%s)",
    async (order) => {
      const older = new ScriptRepository("file:///older/");
      const olderRead = older.readFile("same.md");
      const olderScript = browser.scripts[0]!;
      const newer = new ScriptRepository("file:///newer/");
      const newerRead = newer.readFile("same.md");
      const newerScript = browser.scripts[1]!;

      if (order === "old-first") {
        registerAndLoad(olderScript, "same.md", "older payload");
        registerAndLoad(newerScript, "same.md", "newer payload");
      } else {
        registerAndLoad(newerScript, "same.md", "newer payload");
        registerAndLoad(olderScript, "same.md", "older payload");
      }

      await expect(olderRead).resolves.toBe("older payload");
      await expect(newerRead).resolves.toBe("newer payload");
    }
  );

  it("does not let a new instance inherit an older pending read or manifest", async () => {
    const older = new ScriptRepository("file:///older/", { absence: "manifest" });
    const olderRead = older.readFile("older.md");
    const olderManifest = browser.scripts[0]!;
    const newer = new ScriptRepository("file:///newer/", { absence: "manifest" });
    const newerRead = newer.readFile("newer.md");
    const newerManifest = browser.scripts[1]!;

    registerManifestAndLoad(olderManifest, ["older.md"]);
    registerManifestAndLoad(newerManifest, ["newer.md"]);
    await flushMicrotasks();
    const olderPayload = browser.scripts[2]!;
    const newerPayload = browser.scripts[3]!;
    registerAndLoad(olderPayload, "older.md", "older payload");
    registerAndLoad(newerPayload, "newer.md", "newer payload");

    await expect(olderRead).resolves.toBe("older payload");
    await expect(newerRead).resolves.toBe("newer payload");
  });

  it("uses the latest instance when a registration has no current script", async () => {
    new ScriptRepository("file:///older/");
    const latest = new ScriptRepository("file:///latest/");
    globalThis.__STATICQL_SCRIPT__!.register("direct.md", "latest payload");

    await expect(latest.readFile("direct.md")).resolves.toBe("latest payload");
    expect(browser.scripts).toHaveLength(0);
  });

  it("lists source files from generated slug prefix indexes like FsRepository", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-script-repository-"));
    temporaryRoots.push(root);
    const contentRoot = path.join(root, "content");
    fs.cpSync(fileURLToPath(new URL("./content/", import.meta.url)), contentRoot, { recursive: true });

    const filesystemRepository = new FsRepository(root);
    const staticql = defineStaticQL(staticqlConfig as StaticQLConfig)({ repository: filesystemRepository });
    await staticql.saveIndexes();

    const payloads = new Map<string, { path: string; content: string }>();
    for (const file of recursivelyListFiles(root)) {
      const relativePath = path.relative(root, file).split(path.sep).join("/");
      const url = new URL(`${relativePath}.js`, "https://payload.test/").href;
      payloads.set(url, { path: relativePath, content: fs.readFileSync(file, "utf8") });
    }
    browser.onAppend = (script) => {
      const payload = payloads.get(script.src);
      if (!payload) {
        script.onerror!();
        return;
      }
      registerAndLoad(script, payload.path, payload.content);
    };

    const scriptRepository = new ScriptRepository("https://payload.test/");
    scriptRepository.setResolver(new SourceConfigResolver((staticqlConfig as StaticQLConfig).sources));
    const patterns = Object.values(staticqlConfig.sources).map((source) => source.pattern);
    for (const pattern of patterns) {
      const expected = (await filesystemRepository.listFiles(pattern)).sort();
      const actual = (await scriptRepository.listFiles(pattern)).sort();
      expect(actual, pattern).toEqual(expected);
    }
  });

  it.each(["writeFile", "removeFile", "removeDir"] as const)("rejects %s", async (method) => {
    const repository = new ScriptRepository("file:///data/");
    const operation = method === "writeFile"
      ? repository.writeFile("a", "content")
      : method === "removeFile"
        ? repository.removeFile("a")
        : repository.removeDir("a");

    await expect(operation).rejects.toThrow(`is not supported by ScriptRepository`);
  });

  it("opens registered contents as a UTF-8 readable stream", async () => {
    const repository = new ScriptRepository("file:///data/");
    const stream = repository.openFileStream("unicode.txt");
    registerAndLoad(browser.scripts[0]!, "unicode.txt", "静的 SQL 🌿");

    const reader = (await stream).getReader();
    const result = await reader.read();
    expect(new TextDecoder().decode(result.value)).toBe("静的 SQL 🌿");
    expect(result.done).toBe(false);
    expect(await reader.read()).toEqual({ value: undefined, done: true });
  });
});
