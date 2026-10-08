import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineStaticQL, StaticQLConfig } from "../src/index.js";
import { StaticQL } from "../src/StaticQL.js";
import { FsRepository } from "../src/repository/FsRepository.js";
import { DiffEntry, SourceRecord } from "../src/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function writeRecord(root: string, source: string, record: Record<string, unknown>) {
  const fields = Object.entries(record).map(([key, value]) =>
    `${key}: ${Array.isArray(value) ? JSON.stringify(value) : value}`
  );
  fs.writeFileSync(path.join(root, source, `${record.slug}.md`), `---\n${fields.join("\n")}\n---\n`);
}

async function createFixture(config: StaticQLConfig, records: Record<string, Record<string, unknown>[]>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-incremental-modify-"));
  roots.push(root);
  for (const source of Object.keys(config.sources)) fs.mkdirSync(path.join(root, source));
  for (const [source, sourceRecords] of Object.entries(records)) {
    for (const record of sourceRecords) writeRecord(root, source, record);
  }
  const staticql = defineStaticQL(config)({ repository: new FsRepository(root) });
  await staticql.saveIndexes();
  return { root, staticql };
}

async function slugs(staticql: StaticQL, field: string, value: string) {
  return (await staticql.from<SourceRecord, string>("s").where(field, "eq", value).exec())
    .data.map((record) => record.slug).sort();
}

const config: StaticQLConfig = {
  sources: {
    s: {
      type: "markdown",
      pattern: "s/*.md",
      schema: { type: "object" },
      index: { name: { indexDepth: 3 }, "bySlug.name": {} },
      relations: {
        bySlug: { type: "hasMany", to: "t", localKey: "target", foreignKey: "slug" },
      },
    },
    t: {
      type: "markdown",
      pattern: "t/*.md",
      schema: { type: "object" },
      index: { name: {} },
    },
  },
};

describe("incremental modify entries (#68)", () => {
  it("replaces old values, preserves shared relation refs, and creates new deep prefixes", async () => {
    const fixture = await createFixture(config, {
      s: [
        { slug: "one", name: "old", target: ["a"] },
        { slug: "two", name: "second", target: ["a"] },
      ],
      t: [
        { slug: "a", name: "oak" },
        { slug: "z", name: "zebra" },
      ],
    });

    writeRecord(fixture.root, "s", { slug: "one", name: "quartz", target: ["z"] });
    const modified: DiffEntry = {
      status: "M",
      source: "s",
      slug: "one",
      oldFields: { slug: "one", name: ["old"], target: ["a"] },
      fields: { slug: "one", name: ["quartz"], target: ["z"] },
    };
    await fixture.staticql.getIndexer().updateIndexesForFiles([modified]);

    expect(await slugs(fixture.staticql, "name", "quartz")).toEqual(["one"]);
    expect(await slugs(fixture.staticql, "name", "old")).toEqual([]);
    expect(await slugs(fixture.staticql, "bySlug.name", "oak")).toEqual(["two"]);
    expect(await slugs(fixture.staticql, "bySlug.name", "zebra")).toEqual(["one"]);

    writeRecord(fixture.root, "s", { slug: "added", name: "xylophone", target: ["a"] });
    await fixture.staticql.getIndexer().updateIndexesForFiles([
      { status: "A", source: "s", slug: "added", fields: { name: ["xylophone"] } },
    ]);
    expect(await slugs(fixture.staticql, "name", "xylophone")).toEqual(["added"]);

    writeRecord(fixture.root, "s", { slug: "external", name: "newapi", target: ["a"] });
    await fixture.staticql.getIndexer().updateIndexesForFiles([
      { status: "M", source: "s", slug: "external", fields: { name: ["newapi"] } },
    ]);
    expect(await slugs(fixture.staticql, "name", "newapi")).toEqual(["external"]);
  });
});
