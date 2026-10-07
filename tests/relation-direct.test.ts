import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineStaticQL, StaticQLConfig } from "../src/index.js";
import { StaticQL } from "../src/StaticQL.js";
import { FsRepository } from "../src/repository/FsRepository.js";
import { DirectRelation, SourceRecord } from "../src/types.js";

type FixtureRecord = { slug: string; [key: string]: unknown };
type JoinedRecord = SourceRecord & {
  bySlug: SourceRecord[];
  byId: SourceRecord[];
  oneById: SourceRecord | null;
};

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-relation-direct-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function relation(type: DirectRelation["type"], foreignKey: string): DirectRelation {
  return { to: "targets", localKey: "rel", foreignKey, type };
}

function writeRecords(source: string, records: FixtureRecord[]) {
  const dir = path.join(root, source);
  fs.mkdirSync(dir);
  for (const record of records) {
    const fields = Object.entries(record).map(([key, value]) =>
      `${key}: ${Array.isArray(value) ? JSON.stringify(value) : value}`
    );
    fs.writeFileSync(path.join(dir, `${record.slug}.md`), `---\n${fields.join("\n")}\n---\n`);
  }
}

async function createFixture(
  rows: FixtureRecord[],
  targets: FixtureRecord[],
  relations: Record<string, DirectRelation>,
  index: NonNullable<StaticQLConfig["sources"][string]["index"]> = {}
): Promise<StaticQL> {
  writeRecords("rows", rows);
  writeRecords("targets", targets);
  const staticql = defineStaticQL({
    sources: {
      rows: {
        type: "markdown", pattern: "rows/*.md",
        schema: {
          type: "object", required: ["rel", "name"],
          properties: {
            rel: { type: "array", items: { type: "string" } },
            name: { type: "string" },
          },
        },
        relations, index: { name: {}, ...index },
      },
      targets: {
        type: "markdown", pattern: "targets/*.md",
        schema: {
          type: "object", required: ["id", "name"],
          properties: { id: { type: "string" }, name: { type: "string" } },
        },
      },
    },
  })({ repository: new FsRepository(root) });
  await staticql.saveIndexes();
  return staticql;
}

const boundaryRows: FixtureRecord[] = [
  { slug: "one", name: "one", rel: ["a"] },
  { slug: "two", name: "two", rel: ["a", "z"] },
  { slug: "both", name: "both", rel: ["a", "ab"] },
];
const boundaryTargets: FixtureRecord[] = [
  { slug: "a", id: "ID-a", name: "a" },
  { slug: "ab", id: "ID-ab", name: "ab" },
  { slug: "z", id: "ID-z", name: "z" },
];
const query = (staticql: StaticQL) => staticql.from<JoinedRecord, string>("rows");
const slugs = (records: SourceRecord[]) => records.map((record) => record.slug).sort();

describe("direct relations (#42)", () => {
  it("joins hasMany and hasOne by foreignKey id rather than the target slug (C1/M1)", async () => {
    const staticql = await createFixture(
      [
        { slug: "matched", name: "matched", rel: ["ID-a"] },
        { slug: "unmatched", name: "unmatched", rel: ["missing-id"] },
      ],
      [{ slug: "t-a", id: "ID-a", name: "target a" }],
      { byId: relation("hasMany", "id"), oneById: relation("hasOne", "id") }
    );
    const { data } = await query(staticql).join("byId").join("oneById").exec();
    expect(data.map((row) => ({
      slug: row.slug,
      many: row.byId.map((target) => ({ slug: target.slug, id: target.id, name: target.name })),
      one: row.oneById,
    }))).toEqual([
      {
        slug: "matched", many: [{ slug: "t-a", id: "ID-a", name: "target a" }],
        one: { slug: "t-a", id: "ID-a", name: "target a", raw: expect.any(String) },
      },
      { slug: "unmatched", many: [], one: null },
    ]);
  });

  it("keeps slug-based hasMany joins independent of the main orderBy (C1)", async () => {
    const staticql = await createFixture(
      boundaryRows, boundaryTargets, { bySlug: relation("hasMany", "slug") }
    );
    const { data } = await query(staticql).orderBy("name").join("bySlug").exec();
    expect(data.map((row) => ({ slug: row.slug, targets: slugs(row.bySlug) }))).toEqual([
      { slug: "both", targets: ["a", "ab"] },
      { slug: "one", targets: ["a"] },
      { slug: "two", targets: ["a", "z"] },
    ]);
  });

  it("preserves the loading error for an unknown foreignKey slug (C1)", async () => {
    const staticql = await createFixture(
      [{ slug: "missing", name: "missing", rel: ["unknown-slug"] }],
      boundaryTargets, { bySlug: relation("hasMany", "slug") }
    );
    await expect(query(staticql).join("bySlug").exec()).rejects.toThrow(
      "Failed to loadBySlug: targets/unknown-slug.md"
    );
  });

  it("matches all three boundary rows exactly in a single join (C2/M2)", async () => {
    const staticql = await createFixture(
      boundaryRows, boundaryTargets, { bySlug: relation("hasMany", "slug") }
    );
    const { data } = await query(staticql).join("bySlug").exec();
    expect(data.map((row) => ({ slug: row.slug, targets: slugs(row.bySlug) }))).toEqual([
      { slug: "both", targets: ["a", "ab"] },
      { slug: "one", targets: ["a"] },
      { slug: "two", targets: ["a", "z"] },
    ]);
  });

  it("includes a target once when a localKey is repeated (C2)", async () => {
    const staticql = await createFixture(
      [{ slug: "repeated", name: "repeated", rel: ["a", "a"] }],
      boundaryTargets, { bySlug: relation("hasMany", "slug") }
    );
    const { data } = await query(staticql).join("bySlug").exec();
    expect(data.map((row) => slugs(row.bySlug))).toEqual([["a"]]);
  });

  it("generates related field indexes with exact matches (C3)", async () => {
    const staticql = await createFixture(
      boundaryRows, boundaryTargets, { bySlug: relation("hasMany", "slug") },
      { "bySlug.name": {} }
    );
    expect(slugs((await query(staticql).where("bySlug.name", "eq", "ab").exec()).data)).toEqual(["both"]);
    expect(slugs((await query(staticql).where("bySlug.name", "eq", "a").exec()).data)).toEqual(["both", "one", "two"]);
    expect(slugs((await query(staticql).where("bySlug.name", "eq", "z").exec()).data)).toEqual(["two"]);
  });

  it.each(["slug-first", "id-first"] as const)(
    "generates both foreignKey indexes for relations in %s order (C4)",
    async (order) => {
      const entries: [string, DirectRelation][] = [
        ["bySlug", relation("hasMany", "slug")],
        ["byId", { ...relation("hasMany", "id"), localKey: "ids" }],
      ];
      const relations = Object.fromEntries(order === "slug-first" ? entries : [...entries].reverse());
      const staticql = await createFixture(
        [{ slug: "row", name: "row", rel: ["a"], ids: ["ID-ab"] }],
        boundaryTargets, relations
      );
      const { data } = await query(staticql).join("bySlug").join("byId").exec();
      expect(data.map((row) => ({
        slug: row.slug, bySlug: slugs(row.bySlug), byId: slugs(row.byId),
      }))).toEqual([{ slug: "row", bySlug: ["a"], byId: ["ab"] }]);
    }
  );

  it.each(["belongsTo", "belongsToMany"] as const)(
    "preserves %s partial matching in generated indexes until #67 (E1)",
    async (type) => {
      // #67 tracks this existing behavior; #42 only changes hasOne/hasMany.
      const staticql = await createFixture(
        boundaryRows, boundaryTargets,
        { inverse: relation(type, "slug"), bySlug: relation("hasMany", "slug") },
        { "inverse.name": {}, "bySlug.name": {} }
      );
      const inverse = await query(staticql).where("inverse.name", "eq", "ab").exec();
      const direct = await query(staticql).where("bySlug.name", "eq", "ab").exec();
      expect(slugs(inverse.data)).toEqual(["both", "two"]);
      expect(slugs(direct.data)).toEqual(["both"]);
    }
  );
});
