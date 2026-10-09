import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineStaticQL, StaticQLConfig } from "../src/index.js";
import { FsRepository } from "../src/repository/FsRepository.js";
import { DiffEntry, Relation } from "../src/types.js";

type FixtureRecord = { slug: string; [key: string]: unknown };
type FixtureData = Record<string, FixtureRecord[]>;
type IndexRow = { v: string; vs?: string };

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function source(name: string, indexes: string[], relations?: Record<string, Relation>) {
  return {
    type: "markdown" as const,
    pattern: `${name}/*.md`,
    schema: { type: "object" },
    index: Object.fromEntries(indexes.map((field) => [field, {}])),
    relations,
  };
}

const relation: Relation = {
  type: "hasMany",
  to: "t",
  localKey: "rel",
  foreignKey: "slug",
};

function config(relations: Record<string, Relation> = { r: relation }): StaticQLConfig {
  return {
    sources: {
      s: source("s", ["r.tags"], relations),
      t: source("t", ["tags", "name"]),
    },
  };
}

function writeRecord(root: string, sourceName: string, record: FixtureRecord) {
  const lines = Object.entries(record).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}: ${JSON.stringify(value)}`;
    if (value === undefined) return `${key}:`;
    return `${key}: ${value}`;
  });
  fs.writeFileSync(path.join(root, sourceName, `${record.slug}.md`), `---\n${lines.join("\n")}\n---\n`);
}

async function createFixture(
  cfg: StaticQLConfig,
  data: FixtureData,
  save = true,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-relation-vs-alignment-"));
  roots.push(root);
  for (const name of Object.keys(cfg.sources)) fs.mkdirSync(path.join(root, name));
  for (const [name, records] of Object.entries(data)) {
    for (const record of records) writeRecord(root, name, record);
  }
  const staticql = defineStaticQL(cfg)({ repository: new FsRepository(root) });
  if (save) await staticql.saveIndexes();
  return { root, staticql };
}

function indexRows(root: string, sourceName = "s", field = "r.tags"): IndexRow[] {
  const directory = path.join(root, "index", `${sourceName}.${field}`);
  const rows: IndexRow[] = [];
  if (!fs.existsSync(directory)) return rows;
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name === "_index.jsonl") {
        for (const line of fs.readFileSync(absolute, "utf8").split(/\r?\n/).filter(Boolean)) {
          const parsed = JSON.parse(line) as IndexRow;
          rows.push({ v: parsed.v, ...(parsed.vs === undefined ? {} : { vs: parsed.vs }) });
        }
      }
    }
  };
  visit(directory);
  return rows.sort((a, b) => `${a.v}:${a.vs ?? ""}`.localeCompare(`${b.v}:${b.vs ?? ""}`));
}

function collectIndexTree(root: string) {
  const files = new Map<string, string>();
  const visit = (directory: string, relative = "") => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const rel = path.posix.join(relative, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, rel);
      else if (entry.isFile()) files.set(rel, fs.readFileSync(absolute, "utf8"));
    }
  };
  visit(path.join(root, "index"));
  return files;
}

function expectIndexTreesMatch(leftRoot: string, rightRoot: string, label: string) {
  const left = collectIndexTree(leftRoot);
  const right = collectIndexTree(rightRoot);
  expect([...left.keys()].sort(), label).toEqual([...right.keys()].sort());
  for (const [relative, content] of right) {
    expect(left.get(relative), relative).toBe(content);
  }
}

const initialData: FixtureData = {
  t: [
    { slug: "a", tags: ["x", "y"], name: "alpha" },
    { slug: "b", tags: ["z"], name: "bravo" },
  ],
  s: [{ slug: "one", rel: ["a", "b"] }],
};

describe("relation index value and vs alignment (#82)", () => {
  it.each([{ relationOrder: ["a", "b"] }, { relationOrder: ["b", "a"] }])(
    "pairs every related array value with its source slug for relation order $relationOrder (T1)",
    async ({ relationOrder }) => {
      const fixture = await createFixture(config(), {
        ...initialData,
        s: [{ slug: "one", rel: relationOrder }],
      });
      expect(indexRows(fixture.root)).toEqual([
        { v: "x", vs: "a" },
        { v: "y", vs: "a" },
        { v: "z", vs: "b" },
      ]);
    },
  );

  it("keeps changed relation indexes byte-identical to a full build (T2)", async () => {
    const cases: Array<{
      name: string;
      finalData: FixtureData;
      changedFile: string;
      changedRecord?: FixtureRecord;
      extraRecords?: Array<{ source: string; record: FixtureRecord }>;
      diff: DiffEntry[];
    }> = [
      {
        name: "remove one value",
        finalData: { ...initialData, t: [{ ...initialData.t[0], tags: ["x"] }, initialData.t[1]] },
        changedFile: "t/a.md",
        changedRecord: { slug: "a", tags: ["x"], name: "alpha" },
        diff: [{ status: "M", source: "t", slug: "a", oldFields: { slug: "a", tags: ["x", "y"], name: ["alpha"] }, fields: { slug: "a", tags: ["x"], name: ["alpha"] } }],
      },
      {
        name: "add one value",
        finalData: { ...initialData, t: [initialData.t[0], { ...initialData.t[1], tags: ["z", "w"] }] },
        changedFile: "t/b.md",
        changedRecord: { slug: "b", tags: ["z", "w"], name: "bravo" },
        diff: [{ status: "M", source: "t", slug: "b", oldFields: { slug: "b", tags: ["z"], name: ["bravo"] }, fields: { slug: "b", tags: ["z", "w"], name: ["bravo"] } }],
      },
      {
        name: "delete a related record",
        finalData: { ...initialData, t: [initialData.t[0]] },
        changedFile: "t/b.md",
        diff: [{ status: "D", source: "t", slug: "b", fields: { slug: "b", tags: ["z"], name: ["bravo"] } }],
      },
      {
        name: "change the root relation targets",
        finalData: { ...initialData, t: [...initialData.t, { slug: "c", tags: ["w", "q"], name: "charlie" }], s: [{ slug: "one", rel: ["a", "c"] }] },
        changedFile: "s/one.md",
        changedRecord: { slug: "one", rel: ["a", "c"] },
        extraRecords: [{ source: "t", record: { slug: "c", tags: ["w", "q"], name: "charlie" } }],
        diff: [
          { status: "M", source: "s", slug: "one", oldFields: { slug: "one", rel: ["a", "b"] }, fields: { slug: "one", rel: ["a", "c"] } },
          { status: "A", source: "t", slug: "c", fields: { slug: "c", tags: ["w", "q"], name: ["charlie"] } },
        ],
      },
      {
        name: "remove all values from one related record",
        finalData: { ...initialData, t: [{ ...initialData.t[0], tags: [] }, initialData.t[1]] },
        changedFile: "t/a.md",
        changedRecord: { slug: "a", tags: [], name: "alpha" },
        diff: [{ status: "M", source: "t", slug: "a", oldFields: { slug: "a", tags: ["x", "y"], name: ["alpha"] }, fields: { slug: "a", tags: [], name: ["alpha"] } }],
      },
    ];

    for (const scenario of cases) {
      const fixture = await createFixture(config(), initialData);
      if (scenario.changedRecord) {
        writeRecord(fixture.root, path.dirname(scenario.changedFile), scenario.changedRecord);
      } else {
        fs.unlinkSync(path.join(fixture.root, scenario.changedFile));
      }
      for (const extra of scenario.extraRecords ?? []) {
        writeRecord(fixture.root, extra.source, extra.record);
      }
      await fixture.staticql.getIndexer().updateIndexesForFiles(scenario.diff);
      expect(indexRows(fixture.root), scenario.name).toEqual(
        scenario.finalData.t.flatMap((target) => {
          const linked = scenario.finalData.s[0].rel as string[];
          return linked.includes(target.slug)
            ? (target.tags as string[]).map((value) => ({ v: value, vs: target.slug }))
            : [];
        }).sort((a, b) => `${a.v}:${a.vs}`.localeCompare(`${b.v}:${b.vs}`)),
      );
      const full = await createFixture(config(), scenario.finalData);
      expectIndexTreesMatch(fixture.root, full.root, scenario.name);
    }
  });

  it("does not emit an index row for a related target with no tags (T3)", async () => {
    const fixture = await createFixture(config(), {
      t: [{ slug: "a", tags: ["x", "y"], name: "alpha" }, { slug: "b", name: "bravo" }],
      s: [{ slug: "one", rel: ["a", "b"] }],
    });
    expect(indexRows(fixture.root)).toEqual([
      { v: "x", vs: "a" },
      { v: "y", vs: "a" },
    ]);
  });

  it("keeps non-relation index rows attributed to their own record (T4)", async () => {
    const cfg: StaticQLConfig = {
      sources: {
        s: source("s", ["slug", "rel", "r.tags"], { r: relation }),
        t: source("t", ["tags", "name"]),
      },
    };
    const fixture = await createFixture(cfg, initialData);
    expect(indexRows(fixture.root, "s", "slug")).toEqual([{ v: "one", vs: "one" }]);
    expect(indexRows(fixture.root, "s", "rel")).toEqual([
      { v: "a", vs: "one" },
      { v: "b", vs: "one" },
    ]);
    expect(indexRows(fixture.root, "t", "tags")).toEqual([
      { v: "x", vs: "a" },
      { v: "y", vs: "a" },
      { v: "z", vs: "b" },
    ]);
  });

  it("attributes hasOne and single-valued relation fields to their target slug (T5)", async () => {
    const hasOne: Relation = { type: "hasOne", to: "t", localKey: "rel", foreignKey: "slug" };
    const cfg: StaticQLConfig = {
      sources: {
        s: source("s", ["r.tags", "r.name"], { r: hasOne }),
        t: source("t", ["tags", "name"]),
      },
    };
    const fixture = await createFixture(cfg, {
      t: [{ slug: "a", tags: ["x", "y"], name: "alpha" }],
      s: [{ slug: "one", rel: "a" }],
    });
    expect(indexRows(fixture.root, "s", "r.tags")).toEqual([
      { v: "x", vs: "a" },
      { v: "y", vs: "a" },
    ]);
    expect(indexRows(fixture.root, "s", "r.name")).toEqual([{ v: "alpha", vs: "a" }]);

    const manyConfig: StaticQLConfig = {
      sources: {
        s: source("s", ["r.tags", "r.name"], { r: relation }),
        t: source("t", ["tags", "name"]),
      },
    };
    const many = await createFixture(manyConfig, {
      t: [{ slug: "a", tags: ["x"], name: "alpha" }, { slug: "b", tags: ["y"], name: "bravo" }],
      s: [{ slug: "one", rel: ["a", "b"] }],
    });
    expect(indexRows(many.root, "s", "r.name")).toEqual([
      { v: "alpha", vs: "a" },
      { v: "bravo", vs: "b" },
    ]);
  });

  it("rebuilds incorrect existing rows on saveIndexes (T6)", async () => {
    const fixture = await createFixture(config(), initialData);
    const indexDirectory = path.join(fixture.root, "index", "s.r.tags");
    const files: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolute);
        else if (entry.name === "_index.jsonl") files.push(absolute);
      }
    };
    visit(indexDirectory);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      const corrupted = rows.map((row) => {
        if (row.v === "y") return { ...row, vs: "b" };
        if (row.v === "z") {
          const { vs: _vs, ...withoutVs } = row;
          return withoutVs;
        }
        return row;
      });
      fs.writeFileSync(file, `${corrupted.map((row) => JSON.stringify(row)).join("\n")}\n`);
    }
    expect(indexRows(fixture.root)).toEqual([
      { v: "x", vs: "a" },
      { v: "y", vs: "b" },
      { v: "z" },
    ]);

    await fixture.staticql.saveIndexes();
    expect(indexRows(fixture.root)).toEqual([
      { v: "x", vs: "a" },
      { v: "y", vs: "a" },
      { v: "z", vs: "b" },
    ]);
  });
});
