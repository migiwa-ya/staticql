import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineStaticQL, StaticQLConfig } from "../src/index.js";
import { StaticQL } from "../src/StaticQL.js";
import { FsRepository } from "../src/repository/FsRepository.js";
import { DiffEntry, Relation, SourceRecord } from "../src/types.js";
import { extractDiff } from "../src/diff/extractDiff.js";
import type { DiffLine, DiffProvider } from "../src/diff/providers/index.js";

type RecordFixture = { slug: string; [key: string]: unknown };
type DataFixture = Record<string, RecordFixture[]>;
type QueryExpectation = { source: string; field: string; value: string; slugs: string[] };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function source(name: string, index: string[], relations?: Record<string, Relation>) {
  return {
    type: "markdown",
    pattern: `${name}/*.md`,
    schema: { type: "object" },
    index: Object.fromEntries(index.map((field) => [field, {}])),
    relations,
  };
}

function writeRecord(root: string, sourceName: string, record: RecordFixture) {
  const dir = path.join(root, sourceName);
  fs.mkdirSync(dir, { recursive: true });
  const fields = Object.entries(record).map(([key, value]) =>
    `${key}: ${Array.isArray(value) ? JSON.stringify(value) : value}`
  );
  fs.writeFileSync(path.join(dir, `${record.slug}.md`), `---\n${fields.join("\n")}\n---\n`);
}

async function createFixture(config: StaticQLConfig, data: DataFixture) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-incremental-relation-"));
  roots.push(root);
  for (const name of Object.keys(config.sources)) fs.mkdirSync(path.join(root, name));
  for (const [name, records] of Object.entries(data)) {
    for (const record of records) writeRecord(root, name, record);
  }
  const staticql = defineStaticQL(config)({ repository: new FsRepository(root) });
  await staticql.saveIndexes();
  return { root, staticql };
}

async function slugsOf(staticql: StaticQL, query: QueryExpectation) {
  const { page } = await staticql.from<SourceRecord, string>(query.source)
    .where(query.field, "eq", query.value).peek();
  return [...new Set(page.flatMap((line) => Object.keys(line.ref)))].sort();
}

async function expectMatchesFull(
  staticql: StaticQL,
  config: StaticQLConfig,
  finalData: DataFixture,
  queries: QueryExpectation[]
) {
  // A separate root prevents old index files from affecting the full-build oracle.
  const full = await createFixture(config, finalData);
  for (const query of queries) {
    const incrementalSlugs = await slugsOf(staticql, query);
    const fullSlugs = await slugsOf(full.staticql, query);
    expect(incrementalSlugs).toEqual(query.slugs);
    expect(fullSlugs).toEqual(query.slugs);
    expect(incrementalSlugs).toEqual(fullSlugs);
  }
}

const bySlug: Relation = { type: "hasMany", to: "t", localKey: "rel", foreignKey: "slug" };
const btm: Relation = { type: "belongsToMany", to: "t", localKey: "ids", foreignKey: "id" };
const directTargets = [
  { slug: "a", id: "ID-a", name: "a" },
  { slug: "z", id: "ID-z", name: "z" },
];

describe("incremental direct relation datasets", () => {
  it.each([false, true])("loads each foreign key independently (C1/M1, reverse=%s)", async (reverse) => {
    const config: StaticQLConfig = { sources: {
      s: source("s", ["btm.name", "bySlug.name"], reverse ? { bySlug, btm } : { btm, bySlug }),
      t: source("t", ["id", "name"]),
    } };
    const fixture = await createFixture(config, { t: directTargets });
    const added = { slug: "two", rel: ["z"], ids: ["ID-a"] };
    writeRecord(fixture.root, "s", added);
    await fixture.staticql.getIndexer().updateIndexesForFiles([{ status: "A", source: "s", slug: "two" }]);
    await expectMatchesFull(fixture.staticql, config, { t: directTargets, s: [added] }, [
      { source: "s", field: "bySlug.name", value: "z", slugs: ["two"] },
      { source: "s", field: "btm.name", value: "a", slugs: ["two"] },
      { source: "s", field: "bySlug.name", value: "a", slugs: [] },
    ]);
  });

  it("combines existing targets and additions in the same diff (C2/M2)", async () => {
    const config: StaticQLConfig = { sources: {
      s: source("s", ["bySlug.name"], { bySlug }),
      t: source("t", ["id", "name"]),
    } };
    const fixture = await createFixture(config, { t: directTargets });
    const target = { slug: "new", id: "ID-new", name: "new" };
    const added = { slug: "two", rel: ["a", "new"] };
    writeRecord(fixture.root, "t", target);
    writeRecord(fixture.root, "s", added);
    await fixture.staticql.getIndexer().updateIndexesForFiles([
      { status: "A", source: "t", slug: "new" },
      { status: "A", source: "s", slug: "two" },
    ]);
    await expectMatchesFull(fixture.staticql, config, { t: [...directTargets, target], s: [added] }, [
      { source: "s", field: "bySlug.name", value: "a", slugs: ["two"] },
      { source: "s", field: "bySlug.name", value: "new", slugs: ["two"] },
      { source: "s", field: "bySlug.name", value: "z", slugs: [] },
    ]);
  });

  it("keeps identically named relations separate across sources (C3)", async () => {
    const config: StaticQLConfig = { sources: {
      s1: source("s1", ["rel.name"], { rel: { type: "hasMany", to: "t", localKey: "target", foreignKey: "slug" } }),
      s2: source("s2", ["rel.name"], { rel: { type: "hasMany", to: "w", localKey: "target", foreignKey: "id" } }),
      t: source("t", ["name"]),
      w: source("w", ["id", "name"]),
    } };
    const data = { t: [{ slug: "a", name: "a" }], w: [{ slug: "z", id: "ID-z", name: "z" }] };
    const fixture = await createFixture(config, data);
    const x = { slug: "x", target: "a" };
    const y = { slug: "y", target: "ID-z" };
    writeRecord(fixture.root, "s1", x);
    writeRecord(fixture.root, "s2", y);
    await fixture.staticql.getIndexer().updateIndexesForFiles([
      { status: "A", source: "s1", slug: "x" },
      { status: "A", source: "s2", slug: "y" },
    ]);
    await expectMatchesFull(fixture.staticql, config, { ...data, s1: [x], s2: [y] }, [
      { source: "s1", field: "rel.name", value: "a", slugs: ["x"] },
      { source: "s2", field: "rel.name", value: "z", slugs: ["y"] },
      { source: "s1", field: "rel.name", value: "z", slugs: [] },
      { source: "s2", field: "rel.name", value: "a", slugs: [] },
    ]);
  });
});

function throughRelation(type: "hasOneThrough" | "hasManyThrough"): Relation {
  return { type, through: "t", to: "w", sourceLocalKey: "owner", throughForeignKey: "owner",
    throughLocalKey: "target", targetForeignKey: "code" };
}

const throughTargets = {
  t: [
    { slug: "a", id: "ID-a", owner: "OWNER-a", target: "CODE-a", name: "a" },
    { slug: "z", id: "ID-z", owner: "OWNER-z", target: "CODE-z", name: "z" },
  ],
  w: [
    { slug: "a", id: "W-a", code: "CODE-a", name: "a" },
    { slug: "z", id: "W-z", code: "CODE-z", name: "z" },
  ],
};
const throughCases = (["hasOneThrough", "hasManyThrough"] as const).flatMap((type) =>
  (["middle", "target"] as const).flatMap((preload) =>
    [false, true].map((reverse) => ({ type, preload, reverse }))));

describe("incremental through relation datasets", () => {
  it.each(throughCases)("resolves $type with $preload preloading, reverse=$reverse (C4)", async ({ type, preload, reverse }) => {
    const chain = throughRelation(type);
    const direct: Relation = preload === "middle"
      ? { type: "hasMany", to: "t", localKey: "middleId", foreignKey: "id" }
      : { type: "hasMany", to: "w", localKey: "targetId", foreignKey: "id" };
    const config: StaticQLConfig = { sources: {
      s: source("s", ["owner", "chain.name", "direct.name"], reverse ? { chain, direct } : { direct, chain }),
      t: source("t", ["id", "owner", "target", "name"]),
      w: source("w", ["id", "code", "name"]),
    } };
    const fixture = await createFixture(config, throughTargets);
    const added = { slug: "two", owner: "OWNER-z", middleId: "ID-a", targetId: "W-a" };
    writeRecord(fixture.root, "s", added);
    await fixture.staticql.getIndexer().updateIndexesForFiles([{ status: "A", source: "s", slug: "two" }]);
    await expectMatchesFull(fixture.staticql, config, { ...throughTargets, s: [added] }, [
      { source: "s", field: "chain.name", value: "z", slugs: ["two"] },
      { source: "s", field: "chain.name", value: "a", slugs: [] },
      { source: "s", field: "direct.name", value: "a", slugs: ["two"] },
    ]);
  });

  it("uses generated non-slug indexes for through keys during incremental updates (#71/C3)", async () => {
    const chain = throughRelation("hasManyThrough");
    const config: StaticQLConfig = { sources: {
      s: source("s", ["chain.name"], { chain }),
      t: source("t", ["name"]),
      w: source("w", ["name"]),
    } };
    const fixture = await createFixture(config, throughTargets);
    const added = { slug: "two", owner: "OWNER-z" };
    writeRecord(fixture.root, "s", added);
    await fixture.staticql.getIndexer().updateIndexesForFiles([
      { status: "A", source: "s", slug: "two", fields: { owner: ["OWNER-z"] } },
    ]);
    await expectMatchesFull(fixture.staticql, config, { ...throughTargets, s: [added] }, [
      { source: "s", field: "chain.name", value: "z", slugs: ["two"] },
      { source: "s", field: "chain.name", value: "a", slugs: [] },
    ]);
  });
});

function deleteRecord(root: string, sourceName: string, slug: string) {
  fs.unlinkSync(path.join(root, sourceName, `${slug}.md`));
}

class InMemoryDiffProvider implements DiffProvider {
  constructor(
    private readonly lines: DiffLine[],
    private readonly contents: Map<string, string>
  ) {}

  async diffLines(): Promise<DiffLine[]> {
    return this.lines;
  }

  async gitShow(rev: string, filePath: string): Promise<string> {
    const content = this.contents.get(`${rev}:${filePath}`);
    if (content === undefined) throw new Error(`Missing fixture: ${rev}:${filePath}`);
    return content;
  }
}

function inMemoryDiff(
  config: StaticQLConfig,
  status: DiffLine["status"],
  filePath: string,
  head?: string,
  base?: string
) {
  const contents = new Map<string, string>();
  if (head !== undefined) contents.set(`head:${filePath}`, head);
  if (base !== undefined) contents.set(`base:${filePath}`, base);
  return extractDiff({
    baseRef: "base",
    headRef: "head",
    baseDir: "",
    config,
    diffProvider: new InMemoryDiffProvider([{ status, path: filePath }], contents),
  });
}

const deletedSource: DiffEntry = { status: "D", source: "s", slug: "two",
  fields: { slug: "two", owner: ["KEY-s"], middleId: ["ID-link"], code: [], "chain.name": [], "direct.name": [] } };
const deletedMiddle: DiffEntry = { status: "D", source: "t", slug: "link",
  fields: { slug: "link", owner: ["KEY-s"], target: ["KEY-w"], id: ["ID-link"], name: ["link"], code: [] } };
const deletedTarget: DiffEntry = { status: "D", source: "w", slug: "end",
  fields: { slug: "end", code: ["KEY-w"], id: ["ID-end"], name: ["end"], owner: [] } };

function deletionConfig(preload: boolean): StaticQLConfig {
  const chain = throughRelation("hasManyThrough");
  const direct: Relation = { type: "hasMany", to: "t", localKey: "middleId", foreignKey: "id" };
  return { sources: {
    s: source("s", ["owner", "middleId", "chain.name", "direct.name"], preload ? { direct, chain } : { chain }),
    t: source("t", ["owner", "target", "id", "name"]),
    w: source("w", ["code", "id", "name"]),
  } };
}
const deletionData = {
  s: [{ slug: "two", owner: "KEY-s", middleId: "ID-link" }],
  t: [{ slug: "link", owner: "KEY-s", target: "KEY-w", id: "ID-link", name: "link" }],
  w: [{ slug: "end", code: "KEY-w", id: "ID-end", name: "end" }],
};

describe("incremental deletion views (C5)", () => {
  it.each([false, true])("removes direct relation indexes, target deleted=%s (preserved)", async (deleteTarget) => {
    const config: StaticQLConfig = { sources: {
      s: source("s", ["bySlug.name"], { bySlug }), t: source("t", ["id", "name"]),
    } };
    const fixture = await createFixture(config, { s: [{ slug: "two", rel: ["z"] }], t: directTargets });
    expect(await slugsOf(fixture.staticql, {
      source: "s", field: "bySlug.name", value: "z", slugs: ["two"],
    })).toEqual(["two"]);
    deleteRecord(fixture.root, "s", "two");
    const diff: DiffEntry[] = [{ status: "D", source: "s", slug: "two",
      fields: { slug: "two", rel: ["z"], "bySlug.name": [] } }];
    if (deleteTarget) {
      deleteRecord(fixture.root, "t", "z");
      diff.push({ status: "D", source: "t", slug: "z", fields: { slug: "z", id: ["ID-z"], name: ["z"] } });
    }
    await fixture.staticql.getIndexer().updateIndexesForFiles(diff);
    await expectMatchesFull(fixture.staticql, config, { t: deleteTarget ? [directTargets[0]] : directTargets }, [
      { source: "s", field: "bySlug.name", value: "z", slugs: [] },
    ]);
  });

  it("removes through indexes when source, middle and target are deleted (preserved)", async () => {
    const config = deletionConfig(false);
    const fixture = await createFixture(config, deletionData);
    expect(await slugsOf(fixture.staticql, {
      source: "s", field: "chain.name", value: "end", slugs: ["two"],
    })).toEqual(["two"]);
    for (const entry of [deletedSource, deletedMiddle, deletedTarget]) deleteRecord(fixture.root, entry.source, entry.slug);
    await fixture.staticql.getIndexer().updateIndexesForFiles([deletedSource, deletedMiddle, deletedTarget]);
    await expectMatchesFull(fixture.staticql, config, {}, [
      { source: "s", field: "chain.name", value: "end", slugs: [] },
    ]);
  });

  it.each([true, false])("removes through indexes with source+target D, preload=%s (true: preserved, false: fixed TypeError)", async (preload) => {
    const config = deletionConfig(preload);
    const fixture = await createFixture(config, deletionData);
    expect(await slugsOf(fixture.staticql, {
      source: "s", field: "chain.name", value: "end", slugs: ["two"],
    })).toEqual(["two"]);
    deleteRecord(fixture.root, "s", "two");
    deleteRecord(fixture.root, "w", "end");
    await fixture.staticql.getIndexer().updateIndexesForFiles([deletedSource, deletedTarget]);
    await expectMatchesFull(fixture.staticql, config, { t: deletionData.t }, [
      { source: "s", field: "chain.name", value: "end", slugs: [] },
    ]);
  });

  it("removes through indexes when only the source row is deleted (#72)", async () => {
    const config = deletionConfig(false);
    const fixture = await createFixture(config, deletionData);
    deleteRecord(fixture.root, "s", "two");
    await fixture.staticql.getIndexer().updateIndexesForFiles([deletedSource]);
    await expectMatchesFull(fixture.staticql, config, {
      t: deletionData.t,
      w: deletionData.w,
    }, [
      { source: "s", field: "chain.name", value: "end", slugs: [] },
    ]);
  });

  it("resolves array-valued sourceLocalKey values for through additions", async () => {
    const config: StaticQLConfig = { sources: {
      s: source("s", ["chain.name"], { chain: throughRelation("hasManyThrough") }),
      t: source("t", ["owner", "target", "name"]),
      w: source("w", ["code", "name"]),
    } };
    const arrayThroughTargets = {
      ...throughTargets,
      t: throughTargets.t.map((record) => ({ ...record, target: [record.target] })),
    };
    const fixture = await createFixture(config, arrayThroughTargets);
    const added = { slug: "two", owner: ["OWNER-a", "OWNER-z"] };
    writeRecord(fixture.root, "s", added);
    await fixture.staticql.getIndexer().updateIndexesForFiles([
      { status: "A", source: "s", slug: "two", fields: { owner: added.owner } },
    ]);
    await expectMatchesFull(fixture.staticql, config, { ...arrayThroughTargets, s: [added] }, [
      { source: "s", field: "chain.name", value: "a", slugs: ["two"] },
      { source: "s", field: "chain.name", value: "z", slugs: ["two"] },
    ]);
  });
});

describe("incremental missing-relation errors (E3)", () => {
  it("rejects an empty first direct lookup with the existing message", async () => {
    const config: StaticQLConfig = { sources: {
      s: source("s", ["bySlug.name"], { bySlug }), t: source("t", ["name"]),
    } };
    const fixture = await createFixture(config, { t: directTargets });
    writeRecord(fixture.root, "s", { slug: "two", rel: ["missing"] });
    await expect(fixture.staticql.getIndexer().updateIndexesForFiles([{ status: "A", source: "s", slug: "two" }]))
      .rejects.toThrow("[s] is trying to relate to a non-existent [t] source, or there is an inconsistency in the index. Please check and correct the existence of the difference file and source file, or rebuild the index.");
  });

  it("allows an empty second direct lookup to an already loaded source", async () => {
    const config: StaticQLConfig = { sources: {
      s: source("s", ["btm.name", "bySlug.name"], { btm, bySlug }), t: source("t", ["id", "name"]),
    } };
    const fixture = await createFixture(config, { t: directTargets });
    const added = { slug: "two", ids: ["ID-a"], rel: ["missing"] };
    writeRecord(fixture.root, "s", added);
    await fixture.staticql.getIndexer().updateIndexesForFiles([{ status: "A", source: "s", slug: "two" }]);
    await expectMatchesFull(fixture.staticql, config, { t: directTargets, s: [added] }, [
      { source: "s", field: "btm.name", value: "a", slugs: ["two"] },
      { source: "s", field: "bySlug.name", value: "a", slugs: [] },
    ]);
  });

  it("preserves success when the legacy through input has a target but the correct input does not", async () => {
    const config: StaticQLConfig = { sources: {
      s: source("s", ["owner", "direct.name", "chain.name"], {
        direct: { type: "hasMany", to: "t", localKey: "middleId", foreignKey: "id" },
        chain: throughRelation("hasManyThrough"),
      }),
      t: source("t", ["id", "owner", "target", "name"]), w: source("w", ["id", "code", "name"]),
    } };
    const data = { t: [throughTargets.t[0], { ...throughTargets.t[1], target: "CODE-missing" }], w: [throughTargets.w[0]] };
    const fixture = await createFixture(config, data);
    const added = { slug: "two", owner: "OWNER-z", middleId: "ID-a" };
    writeRecord(fixture.root, "s", added);
    await fixture.staticql.getIndexer().updateIndexesForFiles([{ status: "A", source: "s", slug: "two" }]);
    await expectMatchesFull(fixture.staticql, config, { ...data, s: [added] }, [
      { source: "s", field: "direct.name", value: "a", slugs: ["two"] },
      { source: "s", field: "chain.name", value: "a", slugs: [] },
      { source: "s", field: "chain.name", value: "z", slugs: [] },
    ]);
  });

  it("preserves the missing through index lines error", async () => {
    const config = deletionConfig(false);
    const fixture = await createFixture(config, { t: deletionData.t, w: deletionData.w });
    writeRecord(fixture.root, "s", { slug: "two", owner: "KEY-missing" });
    await expect(fixture.staticql.getIndexer().updateIndexesForFiles([{ status: "A", source: "s", slug: "two" }]))
      .rejects.toThrow("[s] failed to find index lines for through relation: source=t, field=owner");
  });
});

describe("incremental relation propagation from changed targets (#69)", () => {
  const directShapes = [
    {
      name: "hasMany",
      relation: { type: "hasMany", to: "t", localKey: "rel", foreignKey: "slug" } as Relation,
      sourceRows: [
        { slug: "one", rel: ["a"] },
        { slug: "two", rel: ["a"] },
        { slug: "other", rel: ["z"] },
      ],
      targetRows: directTargets,
    },
    {
      name: "belongsTo",
      relation: { type: "belongsTo", to: "t", localKey: "target", foreignKey: "slug" } as Relation,
      sourceRows: [
        { slug: "one", target: "a" },
        { slug: "two", target: "a" },
        { slug: "other", target: "z" },
      ],
      targetRows: directTargets,
    },
    {
      name: "belongsToMany",
      relation: { type: "belongsToMany", to: "t", localKey: "ids", foreignKey: "id" } as Relation,
      sourceRows: [
        { slug: "one", ids: ["ID-a"] },
        { slug: "two", ids: ["ID-a"] },
        { slug: "other", ids: ["ID-z"] },
      ],
      targetRows: directTargets,
    },
  ];

  it.each(directShapes)("propagates target updates for $name", async ({ relation, sourceRows, targetRows }) => {
    const config: StaticQLConfig = { sources: {
      s: source("s", ["r.name"], { r: relation }),
      t: source("t", ["id", "name"]),
    } };
    const fixture = await createFixture(config, { s: sourceRows, t: targetRows });
    const updated = { ...targetRows[0], name: "updated" };
    writeRecord(fixture.root, "t", updated);
    await fixture.staticql.getIndexer().updateIndexesForFiles([{
      status: "M", source: "t", slug: "a",
      fields: { slug: "a", id: ["ID-a"], name: ["updated"] },
      oldFields: { slug: "a", id: ["ID-a"], name: ["a"] },
    }]);
    await expectMatchesFull(fixture.staticql, config, { s: sourceRows, t: [updated, targetRows[1]] }, [
      { source: "s", field: "r.name", value: "updated", slugs: ["one", "two"] },
      { source: "s", field: "r.name", value: "a", slugs: [] },
      { source: "s", field: "r.name", value: "z", slugs: ["other"] },
    ]);
  });

  it.each(directShapes)("removes target deletions for $name", async ({ relation, sourceRows, targetRows }) => {
    const config: StaticQLConfig = { sources: {
      s: source("s", ["r.name"], { r: relation }),
      t: source("t", ["id", "name"]),
    } };
    const fixture = await createFixture(config, { s: sourceRows, t: targetRows });
    deleteRecord(fixture.root, "t", "a");
    await fixture.staticql.getIndexer().updateIndexesForFiles([{
      status: "D", source: "t", slug: "a",
      fields: { slug: "a", id: ["ID-a"], name: ["a"] },
    }]);
    await expectMatchesFull(fixture.staticql, config, { s: sourceRows, t: [targetRows[1]] }, [
      { source: "s", field: "r.name", value: "a", slugs: [] },
      { source: "s", field: "r.name", value: "z", slugs: ["other"] },
    ]);
  });

  it("does not duplicate source rows already present in a combined source and target diff", async () => {
    const relation: Relation = { type: "hasMany", to: "t", localKey: "rel", foreignKey: "slug" };
    const config: StaticQLConfig = { sources: {
      s: source("s", ["r.name"], { r: relation }),
      t: source("t", ["name"]),
    } };
    const sourceRows = [{ slug: "one", rel: ["a"] }];
    const fixture = await createFixture(config, { s: sourceRows, t: directTargets });
    const updatedSource = { slug: "one", rel: ["z"] };
    const updatedTarget = { ...directTargets[0], name: "updated" };
    writeRecord(fixture.root, "s", updatedSource);
    writeRecord(fixture.root, "t", updatedTarget);
    await fixture.staticql.getIndexer().updateIndexesForFiles([
      {
        status: "M", source: "s", slug: "one",
        fields: { slug: "one", rel: ["z"], "r.name": ["z"] },
        oldFields: { slug: "one", rel: ["a"], "r.name": ["a"] },
      },
      {
        status: "M", source: "t", slug: "a",
        fields: { slug: "a", name: ["updated"] },
        oldFields: { slug: "a", name: ["a"] },
      },
    ]);
    await expectMatchesFull(fixture.staticql, config, { s: [updatedSource], t: [updatedTarget, directTargets[1]] }, [
      { source: "s", field: "r.name", value: "updated", slugs: [] },
      { source: "s", field: "r.name", value: "z", slugs: ["one"] },
    ]);
  });

  it("uses both old and new foreign-key values when a belongsToMany target key changes", async () => {
    const relation: Relation = { type: "belongsToMany", to: "t", localKey: "ids", foreignKey: "id" };
    const config: StaticQLConfig = { sources: {
      s: source("s", ["r.name"], { r: relation }),
      t: source("t", ["id", "name"]),
    } };
    const sourceRows = [{ slug: "one", ids: ["ID-a"] }];
    const fixture = await createFixture(config, { s: sourceRows, t: directTargets });
    const updated = { ...directTargets[0], id: "ID-new" };
    writeRecord(fixture.root, "t", updated);
    await fixture.staticql.getIndexer().updateIndexesForFiles([{
      status: "M", source: "t", slug: "a",
      fields: { slug: "a", id: ["ID-new"], name: ["a"] },
      oldFields: { slug: "a", id: ["ID-a"], name: ["a"] },
    }]);
    await expectMatchesFull(fixture.staticql, config, { s: sourceRows, t: [updated, directTargets[1]] }, [
      { source: "s", field: "r.name", value: "a", slugs: [] },
    ]);
  });

  it("ignores dangling source slug keys when propagating direct relations", async () => {
    const relation: Relation = { type: "hasMany", to: "t", localKey: "slug", foreignKey: "owner" };
    const config: StaticQLConfig = { sources: {
      s: source("s", ["r.name"], { r: relation }),
      t: source("t", ["owner", "name"]),
    } };
    const sourceRows = [{ slug: "one" }];
    const targetRows = [{ slug: "orphan", owner: "missing", name: "old" }];
    const fixture = await createFixture(config, { s: sourceRows, t: targetRows });
    const updated = { ...targetRows[0], name: "updated" };
    writeRecord(fixture.root, "t", updated);
    await fixture.staticql.getIndexer().updateIndexesForFiles([{
      status: "M", source: "t", slug: "orphan",
      fields: { slug: "orphan", owner: ["missing"], name: ["updated"] },
      oldFields: { slug: "orphan", owner: ["missing"], name: ["old"] },
    }]);
    await expectMatchesFull(fixture.staticql, config, { s: sourceRows, t: [updated] }, [
      { source: "s", field: "r.name", value: "updated", slugs: [] },
      { source: "s", field: "r.name", value: "old", slugs: [] },
    ]);
  });

  it.each(["update", "rekey", "delete"] as const)("propagates through-target %s without a throughLocalKey index", async (operation) => {
    const relation = throughRelation("hasManyThrough");
    const config: StaticQLConfig = { sources: {
      s: source("s", ["chain.name"], { chain: relation }),
      t: source("t", ["owner", "target", "name"]),
      w: source("w", ["code", "name"]),
    } };
    const fixture = await createFixture(config, deletionData);
    const finalData = { ...deletionData };
    if (operation === "update" || operation === "rekey") {
      const updated = operation === "update"
        ? { ...deletionData.w[0], name: "updated" }
        : { ...deletionData.w[0], code: "KEY-new" };
      writeRecord(fixture.root, "w", updated);
      finalData.w = [updated];
      await fixture.staticql.getIndexer().updateIndexesForFiles([{
        status: "M", source: "w", slug: "end",
        fields: { slug: "end", code: [updated.code], name: [updated.name] },
        oldFields: { slug: "end", code: ["KEY-w"], name: ["end"] },
      }]);
      await expectMatchesFull(fixture.staticql, config, finalData, operation === "update"
        ? [
          { source: "s", field: "chain.name", value: "updated", slugs: ["two"] },
          { source: "s", field: "chain.name", value: "end", slugs: [] },
        ]
        : [{ source: "s", field: "chain.name", value: "end", slugs: [] }]);
    } else {
      deleteRecord(fixture.root, "w", "end");
      finalData.w = [];
      await fixture.staticql.getIndexer().updateIndexesForFiles([deletedTarget]);
      await expectMatchesFull(fixture.staticql, config, finalData, [
        { source: "s", field: "chain.name", value: "end", slugs: [] },
      ]);
    }
  });

  it.each(["update", "delete"] as const)("propagates through-row %s", async (operation) => {
    const relation = throughRelation("hasManyThrough");
    const config: StaticQLConfig = { sources: {
      s: source("s", ["chain.name"], { chain: relation }),
      t: source("t", ["owner", "target", "name"]),
      w: source("w", ["code", "name"]),
    } };
    const fixture = await createFixture(config, deletionData);
    if (operation === "update") {
      const updated = { ...deletionData.t[0], owner: "KEY-other" };
      writeRecord(fixture.root, "t", updated);
      await fixture.staticql.getIndexer().updateIndexesForFiles([{
        status: "M", source: "t", slug: "link",
        fields: { slug: "link", owner: ["KEY-other"], target: ["KEY-w"], id: ["ID-link"], name: ["link"] },
        oldFields: { slug: "link", owner: ["KEY-s"], target: ["KEY-w"], id: ["ID-link"], name: ["link"] },
      }]);
      await expectMatchesFull(fixture.staticql, config, { s: deletionData.s, t: [updated], w: deletionData.w }, [
        { source: "s", field: "chain.name", value: "end", slugs: [] },
      ]);
    } else {
      deleteRecord(fixture.root, "t", "link");
      await fixture.staticql.getIndexer().updateIndexesForFiles([deletedMiddle]);
      await expectMatchesFull(fixture.staticql, config, { s: deletionData.s, t: [], w: deletionData.w }, [
        { source: "s", field: "chain.name", value: "end", slugs: [] },
      ]);
    }
  });

  it("matches array-valued through keys when a target changes", async () => {
    const relation = throughRelation("hasManyThrough");
    const config: StaticQLConfig = { sources: {
      s: source("s", ["chain.name"], { chain: relation }),
      t: source("t", ["owner", "target", "name"]),
      w: source("w", ["code", "name"]),
    } };
    const data = {
      ...deletionData,
      t: [{ ...deletionData.t[0], target: ["KEY-w", "KEY-unused"] }],
    };
    const fixture = await createFixture(config, data);
    const updated = { ...deletionData.w[0], name: "updated" };
    writeRecord(fixture.root, "w", updated);
    await fixture.staticql.getIndexer().updateIndexesForFiles([{
      status: "M", source: "w", slug: "end",
      fields: { slug: "end", code: ["KEY-w"], name: ["updated"] },
      oldFields: { slug: "end", code: ["KEY-w"], name: ["end"] },
    }]);
    await expectMatchesFull(fixture.staticql, config, { ...data, w: [updated] }, [
      { source: "s", field: "chain.name", value: "updated", slugs: ["two"] },
      { source: "s", field: "chain.name", value: "end", slugs: [] },
    ]);
  });

  it("updates relation indexes from an extractDiff-only target field change", async () => {
    const relation: Relation = { type: "hasMany", to: "t", localKey: "rel", foreignKey: "slug" };
    const config: StaticQLConfig = { sources: {
      s: source("s", ["r.name"], { r: relation }),
      t: source("t", []),
    } };
    const sourceRows = [{ slug: "one", rel: ["a"] }];
    const targetRows = [{ slug: "a", name: "old" }];
    const fixture = await createFixture(config, { s: sourceRows, t: targetRows });
    const oldText = "---\nslug: a\nname: old\n---\n";
    const newText = "---\nslug: a\nname: updated\n---\n";
    writeRecord(fixture.root, "t", { slug: "a", name: "updated" });

    const entries = await inMemoryDiff(config, "M", "t/a.md", newText, oldText);
    expect(entries).toEqual([{
      status: "M", source: "t", slug: "a",
      fields: { slug: "a", name: ["updated"] },
      oldFields: { slug: "a", name: ["old"] },
    }]);
    await fixture.staticql.getIndexer().updateIndexesForFiles(entries);
    await expectMatchesFull(fixture.staticql, config, {
      s: sourceRows, t: [{ slug: "a", name: "updated" }],
    }, [
      { source: "s", field: "r.name", value: "updated", slugs: ["one"] },
      { source: "s", field: "r.name", value: "old", slugs: [] },
    ]);
  });

  it("removes relation indexes when extractDiff reports a target deletion", async () => {
    const relation: Relation = { type: "hasMany", to: "t", localKey: "rel", foreignKey: "slug" };
    const config: StaticQLConfig = { sources: {
      s: source("s", ["r.name"], { r: relation }),
      t: source("t", []),
    } };
    const sourceRows = [{ slug: "one", rel: ["a"] }];
    const targetRows = [{ slug: "a", name: "old" }];
    const fixture = await createFixture(config, { s: sourceRows, t: targetRows });
    deleteRecord(fixture.root, "t", "a");
    const oldText = "---\nslug: a\nname: old\n---\n";
    const entries = await inMemoryDiff(config, "D", "t/a.md", undefined, oldText);
    expect(entries).toEqual([{
      status: "D", source: "t", slug: "a",
      fields: { slug: "a", name: ["old"] },
    }]);
    await fixture.staticql.getIndexer().updateIndexesForFiles(entries);
    await expectMatchesFull(fixture.staticql, config, { s: sourceRows, t: [] }, [
      { source: "s", field: "r.name", value: "old", slugs: [] },
    ]);
  });

  it("uses extractDiff old and new throughLocalKey values on a through-row rekey", async () => {
    const relation = throughRelation("hasManyThrough");
    const config: StaticQLConfig = { sources: {
      s: source("s", ["chain.name"], { chain: relation }),
      t: source("t", []),
      w: source("w", []),
    } };
    const sourceRows = [{ slug: "two", owner: "KEY-s" }];
    const throughRows = [{ slug: "link", owner: "KEY-s", target: "KEY-w" }];
    const targetRows = [
      { slug: "end", code: "KEY-w", name: "old" },
      { slug: "next", code: "KEY-z", name: "new" },
    ];
    const fixture = await createFixture(config, { s: sourceRows, t: throughRows, w: targetRows });
    const oldText = "---\nslug: link\nowner: KEY-s\ntarget: KEY-w\n---\n";
    const newText = "---\nslug: link\nowner: KEY-s\ntarget: KEY-z\n---\n";
    writeRecord(fixture.root, "t", { slug: "link", owner: "KEY-s", target: "KEY-z" });

    const entries = await inMemoryDiff(config, "M", "t/link.md", newText, oldText);
    expect(entries).toEqual([{
      status: "M", source: "t", slug: "link",
      fields: { owner: ["KEY-s"], target: ["KEY-z"], slug: "link" },
      oldFields: { owner: ["KEY-s"], target: ["KEY-w"], slug: "link" },
    }]);
    await fixture.staticql.getIndexer().updateIndexesForFiles(entries);
    await expectMatchesFull(fixture.staticql, config, {
      s: sourceRows,
      t: [{ slug: "link", owner: "KEY-s", target: "KEY-z" }],
      w: targetRows,
    }, [
      { source: "s", field: "chain.name", value: "old", slugs: [] },
      { source: "s", field: "chain.name", value: "new", slugs: ["two"] },
    ]);
  });

  it("preserves old throughLocalKey values in extractDiff deletions", async () => {
    const relation = throughRelation("hasManyThrough");
    const config: StaticQLConfig = { sources: {
      s: source("s", ["chain.name"], { chain: relation }),
      t: source("t", []),
      w: source("w", []),
    } };
    const sourceRows = [{ slug: "two", owner: "KEY-s" }];
    const throughRows = [{ slug: "link", owner: "KEY-s", target: "KEY-w" }];
    const targetRows = [{ slug: "end", code: "KEY-w", name: "old" }];
    const fixture = await createFixture(config, { s: sourceRows, t: throughRows, w: targetRows });
    deleteRecord(fixture.root, "t", "link");
    const oldText = "---\nslug: link\nowner: KEY-s\ntarget: KEY-w\n---\n";

    const entries = await inMemoryDiff(config, "D", "t/link.md", undefined, oldText);
    expect(entries).toEqual([{
      status: "D", source: "t", slug: "link",
      fields: { owner: ["KEY-s"], target: ["KEY-w"], slug: "link" },
    }]);
    await fixture.staticql.getIndexer().updateIndexesForFiles(entries);
    await expectMatchesFull(fixture.staticql, config, { s: sourceRows, t: [], w: targetRows }, [
      { source: "s", field: "chain.name", value: "old", slugs: [] },
    ]);
  });
});
