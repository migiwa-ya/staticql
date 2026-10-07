import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineStaticQL, InMemoryCacheProvider, isNotFoundError, NotFoundError, StaticQLConfig } from "../src/index.js";
import { FsRepository } from "../src/repository/FsRepository.js";
import { FetchRepository } from "../src/repository/FetchRepository.js";
import { R2Repository, R2Bucket } from "../src/repository/R2Repository.js";
import { CachedRepository } from "../src/repository/CachedRepository.js";
import { MultiRepository } from "../src/repository/MultiRepository.js";
import { StorageRepository } from "../src/repository/StorageRepository.js";
import { SourceRecord } from "../src/types.js";

type Item = SourceRecord & { name: string };
const config: StaticQLConfig = { sources: { p: {
  type: "markdown", pattern: "p/*.md",
  schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
  index: { name: { indexDepth: 2 } },
} } };
const baseUrl = "https://indexes.test/";
const nameRoot = "index/p.name";
const shortIndex = `${nameRoot}/0061/_index.jsonl`;
const longIndex = `${nameRoot}/0061/0062/_index.jsonl`;
const childPrefixes = `${nameRoot}/0061/_prefixes.jsonl`;
const leafPrefixes = `${nameRoot}/0061/0062/_prefixes.jsonl`;
const rootPrefixes = `${nameRoot}/_prefixes.jsonl`;
let root: string;
let files: Map<string, string>;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(fileURLToPath(new URL(".", import.meta.url)), ".tmp-index-read-"));
  fs.mkdirSync(path.join(root, "p"));
  ["a", "ab", "ac", "b"].forEach((name, i) => fs.writeFileSync(path.join(root, "p", `item${i}.md`),
    `---\nname: ${name}\n---\n`));
  await defineStaticQL(config)({ repository: new FsRepository(root) }).saveIndexes();
  files = new Map();
  const read = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) read(full);
      else files.set(path.relative(root, full), fs.readFileSync(full, "utf8"));
    }
  };
  read(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

function stubFetch(target?: string, status = 200, method?: string) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const key = String(input).slice(baseUrl.length);
    const verb = init?.method ?? "GET";
    const code = key === target && (!method || verb === method) ? status : files.has(key) ? 200 : 404;
    return new Response(verb === "HEAD" ? null : files.get(key) ?? null, { status: code });
  }));
}

function bucket(target?: string, failure?: Error): R2Bucket {
  return {
    async get(key) {
      if (key === target && failure) throw failure;
      const text = key === target ? undefined : files.get(key);
      if (text === undefined) return null;
      return { body: new Response(text).body!, text: async () => text,
        arrayBuffer: async () => new Response(text).arrayBuffer() };
    },
    async list({ prefix = "" } = {}) {
      return { objects: [...files.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) };
    },
    async put() { throw new Error("Read-only test bucket"); },
    async delete() { throw new Error("Read-only test bucket"); },
  };
}

type Operation = "eq-long" | "eq-short" | "startsWith" | "asc" | "desc" | "asc-before" | "desc-before";
function run(repository: StorageRepository, operation: Operation) {
  const query = defineStaticQL(config)({ repository }).from<Item, string>("p").orderBy("name").pageSize(100);
  switch (operation) {
    case "eq-long": return query.where("name", "eq", "ab").exec();
    case "eq-short": return query.where("name", "eq", "a").exec();
    case "startsWith": return query.where("name", "startsWith", "a").exec();
    case "asc": return query.exec();
    case "desc": return query.orderBy("name", "desc").exec();
    case "asc-before": return query.cursor(undefined, "before").exec();
    case "desc-before": return query.orderBy("name", "desc").cursor(undefined, "before").exec();
  }
}

const reads: [Operation, string][] = [
  ["eq-long", longIndex], ["eq-short", shortIndex], ["startsWith", childPrefixes],
  ["asc", rootPrefixes], ["desc", rootPrefixes],
  ["eq-long", leafPrefixes], ["startsWith", shortIndex], ["asc", longIndex], ["desc", longIndex],
];
const missing: [Operation, string, string[]][] = [
  ["eq-long", longIndex, []], ["eq-short", shortIndex, []],
  ["startsWith", childPrefixes, ["a"]],
  ["asc", longIndex, ["a", "ac", "b"]], ["desc", longIndex, ["b", "ac", "a"]],
  ["asc", rootPrefixes, []], ["desc", rootPrefixes, []],
];
const confirmedBeforeGet: { operation: Operation; expected: string[] }[] = [
  { operation: "eq-short", expected: [] },
  { operation: "asc", expected: ["ab", "ac", "b"] },
  { operation: "desc", expected: ["b", "ac", "ab"] },
  { operation: "asc-before", expected: ["ab", "ac", "b"] },
  { operation: "desc-before", expected: ["b", "ac", "ab"] },
];

describe("index read failures (#58)", () => {
  it.each([403, 503])("rejects HTTP %s for GET and HEAD on visited index paths", async (status) => {
    for (const [operation, target] of reads) {
      stubFetch(target, status);
      await expect(run(new FetchRepository(baseUrl), operation)).rejects.toThrow(
        `Failed to fetch ${baseUrl}${target}: HTTP ${status}`);
    }
    for (const method of ["GET", "HEAD"]) {
      stubFetch(shortIndex, status, method);
      await expect(run(new FetchRepository(baseUrl), "eq-short")).rejects.toThrow(
        `Failed to fetch ${baseUrl}${shortIndex}: HTTP ${status}`);
    }
  });

  it("preserves confirmed HTTP 404 results", async () => {
    for (const [operation, target, expected] of missing) {
      stubFetch(target, 404);
      expect((await run(new FetchRepository(baseUrl), operation)).data.map(item => item.name)).toEqual(expected);
    }
  });

  it.each(confirmedBeforeGet)("treats GET-only 404 after HEAD 200 as absence for $operation", async ({ operation, expected }) => {
    stubFetch(shortIndex, 404);
    expect((await run(new FetchRepository(baseUrl), operation)).data.map(item => item.name)).toEqual(expected);
    stubFetch(shortIndex, 404, "GET");
    await expect(new FetchRepository(baseUrl).exists(shortIndex)).resolves.toBe(true);
    expect((await run(new FetchRepository(baseUrl), operation)).data.map(item => item.name)).toEqual(expected);
  });

  it.each(confirmedBeforeGet)("rejects GET-only 503 after HEAD 200 for $operation", async ({ operation }) => {
    stubFetch(shortIndex, 503, "GET");
    await expect(new FetchRepository(baseUrl).exists(shortIndex)).resolves.toBe(true);
    await expect(run(new FetchRepository(baseUrl), operation)).rejects.toThrow(
      `Failed to fetch ${baseUrl}${shortIndex}: HTTP 503`);
  });

  it.each(["open", "access", "readFile"] as const)("rejects Fs %s EACCES and treats ENOENT as absent", async (method) => {
    const original = fs.promises[method].bind(fs.promises);
    const error = Object.assign(new Error(`Denied: ${longIndex}`), { code: "EACCES" });
    let code = "EACCES";
    vi.spyOn(fs.promises, method).mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]) === path.join(root, longIndex)) {
        if (code === "EACCES") throw error;
        throw Object.assign(new Error("Absent"), { code });
      }
      return (original as (...args: unknown[]) => Promise<unknown>)(...args);
    }) as never);
    const repository = () => method === "readFile"
      ? new CachedRepository(new FsRepository(root), new InMemoryCacheProvider()) : new FsRepository(root);
    for (const operation of ["eq-long", "asc", "desc"] as const) {
      await expect(run(repository(), operation)).rejects.toThrow(error);
    }
    code = "ENOENT";
    expect((await run(repository(), "eq-long")).data).toEqual([]);
  });

  it("returns no matches after an actual index file removal", async () => {
    fs.unlinkSync(path.join(root, longIndex));
    expect((await run(new FsRepository(root), "eq-long")).data).toEqual([]);
    expect((await run(new FsRepository(root), "asc")).data.map(item => item.name)).toEqual(["a", "ac", "b"]);
  });

  it("propagates R2 get failures and preserves null results", async () => {
    for (const [operation, target] of reads) {
      const error = new Error(`R2 unavailable: ${target}`);
      await expect(run(new R2Repository(bucket(target, error)), operation)).rejects.toThrow(error);
    }
    for (const [operation, target, expected] of missing) {
      expect((await run(new R2Repository(bucket(target)), operation)).data.map(item => item.name)).toEqual(expected);
    }
  });

  it.each(["cached", "multi"] as const)("keeps HTTP absence and failures distinct through %s", async (wrapper) => {
    const repository = () => wrapper === "cached"
      ? new CachedRepository(new FetchRepository(baseUrl), new InMemoryCacheProvider())
      : new MultiRepository(new FetchRepository(baseUrl));
    for (const [operation, target] of reads) {
      stubFetch(target, 503);
      await expect(run(repository(), operation)).rejects.toThrow(`Failed to fetch ${baseUrl}${target}: HTTP 503`);
    }
    for (const [operation, target, expected] of missing) {
      stubFetch(target, 404);
      expect((await run(repository(), operation)).data.map(item => item.name)).toEqual(expected);
    }
  });

  it.each(["stream", "json"] as const)("rejects %s failures after opening index content", async (failure) => {
    const targets = failure === "stream" ? reads : reads.filter(([, target]) => target.endsWith("_index.jsonl"));
    for (const [operation, target] of targets) {
      const inner = new FsRepository(root);
      const error = new Error(`Read interrupted: ${target}`);
      const repository: StorageRepository = new Proxy(inner, {
        get(object, key) {
          if (key === "openFileStream") return async (filePath: string) => {
            if (filePath !== target) return object.openFileStream(filePath);
            if (failure === "json") return new Response("{invalid json\n").body!;
            let pulled = false;
            return new ReadableStream<Uint8Array>({
              pull(controller) {
                if (pulled) controller.error(error);
                else {
                  pulled = true;
                  controller.enqueue(new TextEncoder().encode(files.get(target) ?? ""));
                }
              },
            });
          };
          const value = Reflect.get(object, key);
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
      await expect(run(repository, operation)).rejects.toThrow(failure === "json" ? SyntaxError : error);
    }
  });
});

describe("StorageRepository absence contract", () => {
  it("exports a recognizable error with path and optional cause", () => {
    const cause = new Error("ENOENT");
    const error = new NotFoundError("missing", { cause });
    expect(error.path).toBe("missing");
    expect(error.message).toBe("File not found: missing");
    expect(error.cause).toBe(cause);
    expect(isNotFoundError(error)).toBe(true);
    expect(isNotFoundError({ name: "NotFoundError" })).toBe(true);
    expect(isNotFoundError(new Error("Missing"))).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
  });

  it("classifies Fetch absence, HTTP failures, and network failures", async () => {
    const repository = new FetchRepository(baseUrl);
    stubFetch("missing", 404);
    await expect(repository.readFile("missing")).rejects.toBeInstanceOf(NotFoundError);
    await expect(repository.openFileStream("missing")).rejects.toMatchObject({ name: "NotFoundError", path: "missing" });
    await expect(repository.exists("missing")).resolves.toBe(false);
    for (const status of [403, 503]) {
      stubFetch("missing", status);
      for (const method of ["readFile", "openFileStream", "exists"] as const) {
        await expect(repository[method]("missing")).rejects.toThrow(`Failed to fetch ${baseUrl}missing: HTTP ${status}`);
      }
    }
    const error = new TypeError("Network failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    for (const method of ["readFile", "openFileStream", "exists"] as const) {
      await expect(repository[method]("missing")).rejects.toBe(error);
    }
  });

  it("classifies Fs ENOENT and ENOTDIR without hiding access errors", async () => {
    const repository = new FsRepository(root);
    const parentFile = "parent-file";
    fs.writeFileSync(path.join(root, parentFile), "not a directory");
    for (const target of ["missing", `${parentFile}/child`]) {
      await expect(repository.readFile(target)).rejects.toBeInstanceOf(NotFoundError);
      await expect(repository.openFileStream(target)).rejects.toMatchObject({ name: "NotFoundError", path: target });
      await expect(repository.exists(target)).resolves.toBe(false);
    }
    const error = Object.assign(new Error("Denied"), { code: "EACCES" });
    vi.spyOn(fs.promises, "access").mockRejectedValue(error);
    vi.spyOn(fs.promises, "readFile").mockRejectedValue(error);
    vi.spyOn(fs.promises, "open").mockRejectedValue(error);
    for (const method of ["readFile", "openFileStream", "exists"] as const) {
      await expect(repository[method]("missing")).rejects.toBe(error);
    }
  });

  it("classifies R2 null and distinguishes a missing body", async () => {
    const repository = new R2Repository(bucket());
    await expect(repository.readFile("missing")).resolves.toBe("");
    await expect(repository.openFileStream("missing")).rejects.toMatchObject({ name: "NotFoundError", path: "missing" });
    await expect(repository.exists("missing")).resolves.toBe(false);
    const broken = bucket();
    broken.get = async () => ({ body: undefined, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) }) as never;
    await expect(new R2Repository(broken).openFileStream("present")).rejects.toMatchObject({
      name: "Error", message: "R2 object has no body: present",
    });
    expect(isNotFoundError(new Error("R2 object has no body: present"))).toBe(false);
    const error = new Error("Bucket failed");
    for (const method of ["readFile", "openFileStream", "exists"] as const) {
      await expect(new R2Repository(bucket("missing", error))[method]("missing")).rejects.toBe(error);
    }
  });
});
