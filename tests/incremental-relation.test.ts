import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineStaticQL, StaticQLConfig } from "../src/index.js";
import { StaticQL } from "../src/StaticQL.js";
import { FsRepository } from "../src/repository/FsRepository.js";
import { DiffEntry, Relation, SourceRecord } from "../src/types.js";

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
