import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineStaticQL, StaticQLConfig } from "../src/index.js";
import { StaticQL } from "../src/StaticQL.js";
import { FsRepository } from "../src/repository/FsRepository.js";
import { StorageRepository } from "../src/repository/StorageRepository.js";
import { SourceRecord } from "../src/types.js";
import { PrefixIndexLine } from "../src/utils/typs.js";
import { encodeCursor } from "../src/utils/pagenation.js";

type Item = SourceRecord & { group: string; name?: string; tags: string[]; code: string };
type FixtureItem = Omit<Item, "raw">;
const records: FixtureItem[] = [
  { slug: "alpha", group: "all", name: "ゴボウ", tags: ["antioxidant", "memory"], code: "a" },
  { slug: "beta", group: "all", name: "ゴツゴラ", tags: ["memory", "skin"], code: "ab" },
  { slug: "gamma", group: "all", name: "ab", tags: ["amber"], code: "abz" },
  { slug: "delta", group: "all", name: "aB", tags: ["apple"], code: "ac" },
  { slug: "epsilon", group: "all", name: "abz", tags: ["beta"], code: "b" },
  { slug: "zeta", group: "all", name: "ac", tags: ["bitter"], code: "ba" },
  { slug: "eta", group: "all", name: "Ab", tags: ["alpha"], code: "B" },
  { slug: "theta", group: "all", name: "B", tags: ["zinc"], code: "Ab" },
  { slug: "iota", group: "all", tags: ["amber"], code: "c" },
  { slug: "kappa", group: "all", tags: ["zinc"], code: "d" },
];
const allSlugs = records.map((record) => record.slug).sort();
const config: StaticQLConfig = {
  sources: {
    items: {
      type: "markdown",
      pattern: "content/*.md",
      schema: {
        type: "object",
        required: ["group", "tags", "code"],
        properties: {
          group: { type: "string" }, name: { type: "string" },
          tags: { type: "array", items: { type: "string" } }, code: { type: "string" },
        },
      },
      index: { group: {}, name: {}, tags: {}, code: { indexDepth: 2 } },
    },
  },
};

let root: string;
let staticql: StaticQL;
let mutationRepository: MutationRepository | undefined;

type Mutation = { op: "writeFile" | "removeDir"; path: string };

/** Record Promise completion separately from the underlying filesystem effect. */
class MutationRepository implements StorageRepository {
  readonly started: Mutation[] = [];
  readonly completed: Mutation[] = [];
  readonly operations: Promise<void>[] = [];
  failWritePath?: string;

  constructor(private readonly delegate: FsRepository) {}

  listFiles(pattern: string) { return this.delegate.listFiles(pattern); }
  readFile(filePath: string) { return this.delegate.readFile(filePath); }
  openFileStream(filePath: string) { return this.delegate.openFileStream(filePath); }
  exists(filePath: string) { return this.delegate.exists(filePath); }
  removeFile(filePath: string) { return this.delegate.removeFile(filePath); }

  private record(mutation: Mutation, action: () => Promise<void>) {
    this.started.push(mutation);
    const operation = (async () => {
      await action();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      this.completed.push(mutation);
    })();
    this.operations.push(operation);
    return operation;
  }

  writeFile(filePath: string, data: string | Uint8Array) {
    return this.record({ op: "writeFile", path: filePath }, async () => {
      if (filePath === this.failWritePath) throw new Error("injected index write failure");
      await this.delegate.writeFile(filePath, data);
    });
  }

  removeDir(filePath: string) {
    return this.record({ op: "removeDir", path: filePath }, () => this.delegate.removeDir(filePath));
  }
}
function writeRecord(record: FixtureItem) {
  const lines = Object.entries(record).map(([key, value]) =>
    `${key}: ${Array.isArray(value) ? JSON.stringify(value) : value}`
  );
  fs.writeFileSync(path.join(root, "content", `${record.slug}.md`), `---\n${lines.join("\n")}\n---\n`);
}
const query = () => staticql.from<Item, string>("items");
const slugsOf = (page: PrefixIndexLine[]) => page.flatMap((line) => Object.keys(line.ref));

beforeEach(async () => {
  mutationRepository = undefined;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-query-where-"));
  fs.mkdirSync(path.join(root, "content"));
  records.forEach(writeRecord);
  staticql = defineStaticQL(config)({ repository: new FsRepository(root) });
  await staticql.saveIndexes();
});

afterEach(async () => {
  // Cleanup follows the assertions and also drains the intentionally broken run.
  await Promise.allSettled(mutationRepository?.operations ?? []);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("where AND and record uniqueness", () => {
  it("intersects multiple slug sets without replacing earlier conditions", async () => {
    const { data } = await query().where("slug", "in", ["alpha", "beta", "alpha"])
      .where("slug", "in", ["beta", "gamma"]).exec();
    expect(data.map((item) => item.slug)).toEqual(["beta"]);
    const disjoint = await query().where("slug", "eq", "alpha").where("slug", "eq", "beta").exec();
    expect(disjoint.data).toEqual([]);
  });

  it("preserves unknown slug loading errors for slug-only queries", async () => {
    await expect(query().where("slug", "eq", "unknown").exec()).rejects.toThrow("Failed to loadBySlug");
  });

  it("deduplicates overlapping in values in peek, exec, and a later filter", async () => {
    const makeQuery = () => query().where("tags", "in", ["antioxidant", "memory", "memory"]);
    expect(slugsOf((await makeQuery().peek()).page)).toEqual(["alpha", "beta"]);
    expect((await makeQuery().exec()).data.map((item) => item.slug)).toEqual(["alpha", "beta"]);
    expect(slugsOf((await query().where("group", "eq", "all")
      .where("tags", "in", ["antioxidant", "memory"]).peek()).page)).toEqual(["alpha", "beta"]);
  });

  it.each(["eq", "in"] as const)("checks full values for %s at the depth boundary in both condition orders", async (op) => {
    const condition = (q: ReturnType<typeof query>) => op === "eq"
      ? q.where("code", "eq", "ab") : q.where("code", "in", ["ab"]);
    expect(slugsOf((await condition(query().where("group", "eq", "all")).peek()).page)).toEqual(["beta"]);
    expect(slugsOf((await condition(query()).where("group", "eq", "all").peek()).page)).toEqual(["beta"]);
    expect((await condition(query().where("group", "eq", "all"))
      .where("slug", "eq", "gamma").exec()).data).toEqual([]);
    expect((await condition(query().where("slug", "eq", "gamma"))
      .where("group", "eq", "all").exec()).data).toEqual([]);
  });

  it("uses startsWith matching alone and after another index condition", async () => {
    const expected = ["epsilon", "gamma"];
    expect((await query().where("name", "startsWith", "ab").exec()).data.map((item) => item.slug)).toEqual(expected);
    expect((await query().where("group", "eq", "all").where("name", "startsWith", "ab")
      .exec()).data.map((item) => item.slug)).toEqual(expected);
    expect((await query().where("name", "startsWith", "ab").where("group", "eq", "all")
      .exec()).data.map((item) => item.slug)).toEqual(expected);
  });
});

describe("where cursor pagination", () => {
  it.each([1, 2])("traverses overlapping in matches once in both directions with pageSize %i (M1)", async (pageSize) => {
    const makeQuery = () => query().where("tags", "in", ["antioxidant", "memory"]).pageSize(pageSize);
    const forward: string[] = [];
    let cursor: string | undefined;
    let next = true;
    let lastPage: Awaited<ReturnType<ReturnType<typeof query>["exec"]>> | undefined;
    // A finite bound makes non-terminating cursor regressions fail instead of hang.
    for (let count = 0; next && count < 3; count++) {
      const result = await makeQuery().cursor(cursor).exec();
      forward.push(...result.data.map((item) => item.slug));
      cursor = result.pageInfo.endCursor;
      next = result.pageInfo.hasNextPage;
      lastPage = result;
    }
    expect(next).toBe(false);
    expect(forward).toEqual(["alpha", "beta"]);
    expect(lastPage?.pageInfo.hasNextPage).toBe(false);
    const backward = lastPage!.data.map((item) => item.slug);
    cursor = lastPage!.pageInfo.startCursor;
    let previous = lastPage!.pageInfo.hasPreviousPage;
    for (let count = 0; previous && count < 3; count++) {
      const result = await makeQuery().cursor(cursor, "before").exec();
      backward.unshift(...result.data.map((item) => item.slug));
      cursor = result.pageInfo.startCursor;
      previous = result.pageInfo.hasPreviousPage;
    }
    expect(previous).toBe(false);
    expect(backward).toEqual(["alpha", "beta"]);
  });

  it("returns the last page before no cursor and excludes index 0 cursors", async () => {
    const makeQuery = () => query().where("group", "eq", "all").pageSize(2);
    const last = await makeQuery().cursor(undefined, "before").exec();
    expect(last.data.map((item) => item.slug)).toEqual(allSlugs.slice(-2));
    expect(last.pageInfo.hasNextPage).toBe(false);
    expect(last.pageInfo.hasPreviousPage).toBe(true);
    const first = await makeQuery().exec();
    const after = await makeQuery().cursor(first.pageInfo.startCursor).exec();
    expect(after.data.map((item) => item.slug)).toEqual(allSlugs.slice(1, 3));
    expect(after.pageInfo.hasPreviousPage).toBe(true);
    const before = await makeQuery().cursor(first.pageInfo.startCursor, "before").exec();
    expect(before.data).toEqual([]);
    expect(before.pageInfo.hasPreviousPage).toBe(false);
    expect(before.pageInfo.hasNextPage).toBe(true);
    expect(before.pageInfo.startCursor).toBeUndefined();
    expect(before.pageInfo.endCursor).toBeUndefined();
  });

  it("rejects cursors absent from nonempty or empty filter results", async () => {
    const cursorFor = (slug: string) => encodeCursor({ slug, order: { slug } });
    await expect(query().where("group", "eq", "all").cursor(cursorFor("unknown")).exec()).rejects.toThrow("Cursor");
    await expect(query().where("name", "eq", "ゴボウ").cursor(cursorFor("beta")).exec()).rejects.toThrow("Cursor");
    await expect(query().where("name", "eq", "absent").cursor(cursorFor("alpha")).exec()).rejects.toThrow("Cursor");
  });

  it.each([0, -1, 1.5, NaN])("rejects invalid pageSize %s", (pageSize) => {
    expect(() => query().pageSize(pageSize)).toThrow("positive integer");
  });
});

describe("where ordering matches first occurrences in the walker", () => {
  it.each(["asc", "desc"] as const)("matches full and subset order in %s, including arrays and depth 2", async (direction) => {
    const subsets = ["alpha", "beta", "gamma", "epsilon", "iota", "kappa"];
    for (const key of ["name", "tags", "code"]) {
      const reference = (await query().orderBy(key, direction).pageSize(100).exec()).data;
      const referenceSlugs = [...new Set(reference.map((item) => item.slug))];
      const missing = key === "name" ? ["iota", "kappa"] : [];
      const expected = [...referenceSlugs, ...missing];
      expect([...expected].sort()).toEqual(allSlugs);
      expect(expected.length).toBe(records.length);
      const full = await query().where("group", "eq", "all").orderBy(key, direction).pageSize(100).exec();
      expect(full.data.map((item) => item.slug)).toEqual(expected);
      expect(full.data.length).toBe(records.length);
      expect(full.pageInfo.hasPreviousPage).toBe(false);
      expect(full.pageInfo.hasNextPage).toBe(false);
      const subsetExpected = expected.filter((slug) => subsets.includes(slug));
      const subset = await query().where("group", "eq", "all").where("slug", "in", subsets)
        .orderBy(key, direction).pageSize(100).exec();
      expect(subset.data.map((item) => item.slug)).toEqual(subsetExpected);
      expect(subset.data.map((item) => item.slug).sort()).toEqual([...subsets].sort());
      expect(subset.data.length).toBe(subsets.length);
      const slugOnly = await query().where("slug", "in", subsets).orderBy(key, direction).pageSize(100).exec();
      expect(slugOnly.data.map((item) => item.slug)).toEqual(subsetExpected);
      expect(slugOnly.data.length).toBe(subsets.length);
    }
    const names = await query().where("group", "eq", "all").orderBy("name", direction).pageSize(100).exec();
    expect(names.data.slice(-2).map((item) => item.slug)).toEqual(["iota", "kappa"]);
    const code = await query().where("group", "eq", "all").orderBy("code", direction).pageSize(100).exec();
    const codeSlugs = code.data.map((item) => item.slug);
    const orderedPairs = direction === "asc"
      ? [["alpha", "beta"], ["epsilon", "zeta"]]
      : [["beta", "alpha"], ["zeta", "epsilon"]];
    for (const [first, second] of orderedPairs) {
      expect(codeSlugs.indexOf(first)).toBeLessThan(codeSlugs.indexOf(second));
    }
  });

  it("paginates records with missing order values without losing them", async () => {
    const makeQuery = () => query().where("slug", "in", ["alpha", "iota", "kappa"])
      .orderBy("name").pageSize(1);
    const first = await makeQuery().exec();
    const second = await makeQuery().cursor(first.pageInfo.endCursor).exec();
    const third = await makeQuery().cursor(second.pageInfo.endCursor).exec();
    expect(first.data.map((item) => item.slug)).toEqual(["alpha"]);
    expect(second.data.map((item) => item.slug)).toEqual(["iota"]);
    expect(third.data.map((item) => item.slug)).toEqual(["kappa"]);
    expect(third.pageInfo.hasNextPage).toBe(false);
    expect(second.pageInfo.endCursor).toBeDefined();
  });

  it("requires an orderBy index on the filtered path", async () => {
    await expect(query().where("group", "eq", "all").orderBy("missing").exec()).rejects.toThrow("[items] needs index: missing");
  });
});

describe("short exact values", () => {
  it.each(["eq", "in"] as const)("finds a short %s value alone and with slug filters in either order (C11)", async (op) => {
    const condition = (q: ReturnType<typeof query>) => op === "eq"
      ? q.where("code", "eq", "a") : q.where("code", "in", ["a"]);
    expect((await condition(query()).exec()).data.map((item) => item.slug)).toEqual(["alpha"]);
    expect((await condition(query().where("slug", "eq", "alpha")).exec()).data.map((item) => item.slug)).toEqual(["alpha"]);
    expect((await condition(query()).where("slug", "eq", "alpha").exec()).data.map((item) => item.slug)).toEqual(["alpha"]);
    expect((await condition(query().where("slug", "eq", "beta")).exec()).data).toEqual([]);
  });

  it("returns empty when the short value's file is absent", async () => {
    expect((await query().where("code", "eq", "z").exec()).data).toEqual([]);
    expect((await query().where("code", "in", ["z"]).exec()).data).toEqual([]);
  });

  it("propagates invalid JSONL in the short value's existing file", async () => {
    fs.writeFileSync(path.join(root, "index/items.code/0061/_index.jsonl"), "invalid JSON");
    await expect(query().where("code", "eq", "a").exec()).rejects.toThrow();
  });
});

function indexFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? indexFiles(full) : [full];
  });
}

function checkIndexOrder() {
  const files = indexFiles(path.join(root, "index"));
  const rowFiles = files.filter((file) => file.endsWith("_index.jsonl"));
  const prefixFiles = files.filter((file) => file.endsWith("_prefixes.jsonl"));
  expect(rowFiles.length).toBeGreaterThan(0);
  expect(prefixFiles.length).toBeGreaterThan(0);
  for (const file of rowFiles) {
    const lines: PrefixIndexLine[] = fs.readFileSync(file, "utf8").split("\n").map((line) => JSON.parse(line));
    const values = lines.map((line) => line.v);
    expect(values.length).toBeGreaterThan(0);
    expect(values).toEqual([...values].sort());
  }
  for (const file of prefixFiles) {
    const prefixes = fs.readFileSync(file, "utf8").split("\n");
    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes).toEqual([...prefixes].sort());
  }
}

describe("ordinal index generation", () => {
  it("sorts rows and prefix dictionaries during full generation and incremental addition", async () => {
    checkIndexOrder();
    const added: FixtureItem = { slug: "lambda", group: "all", name: "aardvark", tags: ["azure", "Aster"], code: "aB" };
    writeRecord(added);
    await staticql.getIndexer().updateIndexesForFiles([{ status: "A", source: "items", slug: added.slug }]);
    checkIndexOrder();
    const nameLines: PrefixIndexLine[] = fs.readFileSync(path.join(root, "index/items.name/0061/_index.jsonl"), "utf8")
      .split("\n").map((line) => JSON.parse(line));
    expect(nameLines.map((line) => line.v)).toContain("aardvark");
    const codeLines: PrefixIndexLine[] = fs.readFileSync(path.join(root, "index/items.code/0061/0042/_index.jsonl"), "utf8")
      .split("\n").map((line) => JSON.parse(line));
    expect(codeLines.map((line) => line.v)).toEqual(["aB"]);
    expect(Object.keys(codeLines[0].ref)).toEqual(["lambda"]);
    const prefixes = fs.readFileSync(path.join(root, "index/items.code/0061/_prefixes.jsonl"), "utf8").split("\n");
    expect(prefixes).toEqual(["0042", "0062", "0063"]);
    expect(fs.readFileSync(path.join(root, "index/items.tags/_prefixes.jsonl"), "utf8").split("\n")).toContain("0041");
  });
});

describe("incremental mutation completion (C12)", () => {
  function useMutationRepository() {
    mutationRepository = new MutationRepository(new FsRepository(root));
    staticql = defineStaticQL(config)({ repository: mutationRepository });
    return mutationRepository;
  }

  function expectAllCompleted(repository: MutationRepository) {
    expect(repository.started.length).toBeGreaterThan(0);
    expect(repository.completed.length).toBe(repository.started.length);
    expect(repository.completed).toEqual(repository.started);
  }

  it("waits for index and prefix write Promises before resolving", async () => {
    const repository = useMutationRepository();
    writeRecord({ slug: "lambda", group: "all", name: "aardvark", tags: ["azure"], code: "aB" });
    await staticql.getIndexer().updateIndexesForFiles([{ status: "A", source: "items", slug: "lambda" }]);
    // No extra await between update resolution and the completion checks.
    expectAllCompleted(repository);
    expect(repository.started).toContainEqual({ op: "writeFile", path: "index/items.code/0061/0042/_index.jsonl" });
    expect(repository.completed).toContainEqual({ op: "writeFile", path: "index/items.code/0061/0042/_index.jsonl" });
    expect(repository.started).toContainEqual({ op: "writeFile", path: "index/items.code/0061/_prefixes.jsonl" });
    expect(repository.completed).toContainEqual({ op: "writeFile", path: "index/items.code/0061/_prefixes.jsonl" });
    const lines = fs.readFileSync(path.join(root, "index/items.code/0061/0042/_index.jsonl"), "utf8")
      .split("\n").map((line) => JSON.parse(line) as PrefixIndexLine);
    expect(lines.map((line) => line.v)).toEqual(["aB"]);
    expect(Object.keys(lines[0].ref)).toEqual(["lambda"]);
    expect(fs.readFileSync(path.join(root, "index/items.code/0061/_prefixes.jsonl"), "utf8").split("\n"))
      .toEqual(["0042", "0062", "0063"]);
  });

  it("waits for empty index directory removal before resolving", async () => {
    const repository = useMutationRepository();
    await staticql.getIndexer().updateIndexesForFiles([
      { status: "D", source: "items", slug: "theta", fields: { code: "Ab" } },
    ]);
    expectAllCompleted(repository);
    expect(repository.started).toContainEqual({ op: "removeDir", path: "index/items.code/0041/0062" });
    expect(repository.completed).toContainEqual({ op: "removeDir", path: "index/items.code/0041/0062" });
    expect(fs.existsSync(path.join(root, "index/items.code/0041/0062"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "index/items.code/_prefixes.jsonl"), "utf8").split("\n"))
      .toEqual(["0042", "0061", "0062", "0063", "0064"]);
  });

  it("rejects with the repository write error instead of returning success", async () => {
    const repository = useMutationRepository();
    repository.failWritePath = "index/items.code/0061/0042/_index.jsonl";
    writeRecord({ slug: "lambda", group: "all", name: "aardvark", tags: ["azure"], code: "aB" });
    await expect(staticql.getIndexer().updateIndexesForFiles([
      { status: "A", source: "items", slug: "lambda" },
    ])).rejects.toThrow("injected index write failure");
    expect(repository.started).toContainEqual({ op: "writeFile", path: repository.failWritePath });
  });
});
