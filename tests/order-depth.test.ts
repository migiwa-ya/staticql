import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineStaticQL, InMemoryCacheProvider, StaticQLConfig } from "../src/index.js";
import { FsRepository } from "../src/repository/FsRepository.js";
import { R2Repository, R2Bucket } from "../src/repository/R2Repository.js";
import { CachedRepository } from "../src/repository/CachedRepository.js";
import { StorageRepository } from "../src/repository/StorageRepository.js";
import { SourceRecord } from "../src/types.js";
import { PrefixIndexDepth } from "../src/utils/typs.js";
import { decodeCursor } from "../src/utils/pagenation.js";
import { compareOrdinal, getPrefixIndexPath } from "../src/constants.js";

type Item = SourceRecord & { name: string; group: string };
const values = ["a", "ab", "ac", "b", "ba", "B", "Ab"];
const ascending = ["Ab", "B", "a", "ab", "ac", "b", "ba"];
const directions = ["asc", "desc"] as const;
const depths = [1, 2, 3] as const;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fileURLToPath(new URL(".", import.meta.url)), ".tmp-order-depth-"));
  fs.mkdirSync(path.join(root, "p"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function config(depth: PrefixIndexDepth): StaticQLConfig {
  return { sources: { p: {
    type: "markdown", pattern: "p/*.md",
    schema: { type: "object", required: ["name", "group"], properties: {
      name: { type: "string" }, group: { type: "string" },
    } },
    index: { name: { indexDepth: depth }, group: {} },
  } } };
}

async function fixture(depth: PrefixIndexDepth, names = values) {
  names.forEach((name, i) => fs.writeFileSync(path.join(root, "p", `item${i}.md`),
    `---\nname: ${name}\ngroup: all\n---\n`));
  const sq = defineStaticQL(config(depth))({ repository: new FsRepository(root) });
  await sq.saveIndexes();
  return sq;
}

function r2FromFixture(): StorageRepository {
  const files = new Map<string, string>();
  const read = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) read(full);
      else files.set(path.relative(root, full), fs.readFileSync(full, "utf8"));
    }
  };
  read(root);
  const bucket: R2Bucket = {
    async get(key) {
      const text = files.get(key);
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
  return new CachedRepository(new R2Repository(bucket), new InMemoryCacheProvider());
}

describe("orderBy across index depths (#55)", () => {
  it.each(depths)("orders non-BMP values and preserves emoji filters at depth %s", async (depth) => {
    const names = ["😀a", "😁", "😀", "a", "あ"];
    const sq = await fixture(depth, names);
    const ascending = [...names].sort(compareOrdinal);

    for (const direction of directions) {
      const expected = direction === "asc" ? ascending : [...ascending].reverse();
      const query = () => sq.from<Item, string>("p").orderBy("name", direction).pageSize(100);
      expect((await query().exec()).data.map((item) => item.name)).toEqual(expected);
      expect((await query().where("name", "eq", "😀").exec()).data.map((item) => item.name))
        .toEqual(["😀"]);
      expect((await query().where("name", "startsWith", "😀").exec()).data.map((item) => item.name))
        .toEqual(expected.filter((name) => name.startsWith("😀")));
    }
  });

  it.each(depths)("orders full and filtered results at depth %s", async (depth) => {
    const sq = await fixture(depth);
    for (const direction of directions) {
      const expected = direction === "asc" ? ascending : [...ascending].reverse();
      const query = () => sq.from<Item, string>("p").orderBy("name", direction).pageSize(100);
      expect((await query().exec()).data.map(item => item.name)).toEqual(expected);
      expect((await query().where("group", "eq", "all").exec()).data.map(item => item.name)).toEqual(expected);
      const selected = ["item0", "item1", "item4", "item6"];
      const subset = expected.filter(name => selected.includes(`item${values.indexOf(name)}`));
      expect((await query().where("slug", "in", selected).exec()).data.map(item => item.name)).toEqual(subset);
    }
  });

  it.each(depths.flatMap(depth => directions.map(direction => ({ depth, direction }))))(
    "paginates forward and backward in $direction without losing rows at depth $depth", async ({ depth, direction }) => {
    const sq = await fixture(depth);
      const expected = direction === "asc" ? ascending : [...ascending].reverse();
      const query = () => sq.from<Item, string>("p").orderBy("name", direction).pageSize(2);
      const forward: string[] = [];
      let cursor: string | undefined;
      let last = await query().exec();
      for (let page = 0; page < values.length; page++) {
        last = await query().cursor(cursor).exec();
        forward.push(...last.data.map(item => item.name));
        cursor = last.pageInfo.endCursor;
        if (!last.pageInfo.hasNextPage) break;
      }
      expect(forward).toEqual(expected);
      expect(last.pageInfo.hasNextPage).toBe(false);
      const backward = last.data.map(item => item.name);
      cursor = last.pageInfo.startCursor;
      let first = last;
      let end = expected.length - last.data.length;
      for (let page = 0; page < values.length && first.pageInfo.hasPreviousPage; page++) {
        first = await query().cursor(cursor, "before").exec();
        const start = Math.max(0, end - 2);
        expect(first.data.map(item => item.name)).toEqual(expected.slice(start, end));
        expect(first.pageInfo.hasPreviousPage).toBe(start > 0);
        expect(first.pageInfo.hasNextPage).toBe(true);
        expect(decodeCursor(first.pageInfo.startCursor!)).toEqual({
          slug: `item${values.indexOf(expected[start])}`,
          order: { name: getPrefixIndexPath(expected[start], depth) },
        });
        expect(decodeCursor(first.pageInfo.endCursor!)).toEqual({
          slug: `item${values.indexOf(expected[end - 1])}`,
          order: { name: getPrefixIndexPath(expected[end - 1], depth) },
        });
        backward.unshift(...first.data.map(item => item.name));
        cursor = first.pageInfo.startCursor;
        end = start;
      }
      expect(backward).toEqual(expected);
      expect(first.pageInfo.hasPreviousPage).toBe(false);
  });

  it("orders BMP Japanese parent and child values", async () => {
    const names = ["あ", "あい", "あう", "い", "いあ", "ア"];
    const sq = await fixture(2, names);
    for (const direction of directions) {
      const expected = [...names].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      if (direction === "desc") expected.reverse();
      expect((await sq.from<Item, string>("p").orderBy("name", direction).pageSize(100).exec())
        .data.map(item => item.name)).toEqual(expected);
    }
  });

  it("keeps directions separate when reusing the same walk cache", async () => {
    const sq = await fixture(2);
    const query = (direction: "asc" | "desc") => sq.from<Item, string>("p").orderBy("name", direction).pageSize(100);
    const asc = await query("asc").exec();
    const desc = await query("desc").exec();
    expect(asc.data.map(item => item.name)).toEqual(ascending);
    expect(desc.data.map(item => item.name)).toEqual([...ascending].reverse());
    expect((await query("asc").cursor(asc.pageInfo.endCursor).exec()).data).toEqual([]);
    expect((await query("desc").cursor(desc.pageInfo.startCursor, "before").exec()).data).toEqual([]);
    const descMiddle = await query("desc").pageSize(3).exec();
    expect((await query("desc").cursor(descMiddle.pageInfo.endCursor).exec()).data.map(item => item.name))
      .toEqual(["ab", "a", "B", "Ab"]);
    const ascMiddle = await query("asc").pageSize(3).exec();
    expect((await query("asc").cursor(ascMiddle.pageInfo.endCursor, "before").exec()).data.map(item => item.name))
      .toEqual(["Ab", "B"]);
  });

  it.each([false, true])("terminates CachedRepository(R2) with absent leaf prefixes (empty=%s)", async (empty) => {
    await fixture(2, empty ? [] : values);
    const sq = defineStaticQL(config(2))({ repository: r2FromFixture() });
    for (const direction of directions) {
      const expected = empty ? [] : direction === "asc" ? ascending : [...ascending].reverse();
      const query = () => sq.from<Item, string>("p").orderBy("name", direction).pageSize(100);
      const first = await query().exec();
      expect(first.data.map(item => item.name)).toEqual(expected);
      expect((await query().cursor(undefined, "before").exec()).data.map(item => item.name)).toEqual(expected);
      expect((await query().cursor(first.pageInfo.endCursor).exec()).data).toEqual([]);
      expect((await query().cursor(first.pageInfo.startCursor, "before").exec()).data).toEqual([]);
    }
  });
});
