import { describe, it, expect, vi, beforeAll } from "vitest";
import { defineStaticQL, StaticQLConfig } from "../src/index";
import { FsRepository } from "../src/repository/FsRepository";
import { HerbsRecord, RecipesRecord } from "./staticql-types";
import staticqlConfig from "./staticql.config.json";

const staticql = defineStaticQL(staticqlConfig as StaticQLConfig)({
  repository: new FsRepository("tests/"),
});

beforeAll(async () => {
  await staticql.saveIndexes();
});

describe("QueryBuilder where", () => {
  it("should find herbs by 'eq' match on indexed field", async () => {
    const { data: herbs } = await staticql
      .from<HerbsRecord>("herbs")
      .where("slug", "eq", "arctium-lappa")
      .exec();

    expect(Array.isArray(herbs)).toBe(true);
    expect(herbs.length).toBe(1);
    expect(herbs[0]?.name).toBe("ゴボウ");
  });

  it("should find herbs by 'in' match on indexed relation field", async () => {
    const { data: recipes } = await staticql
      .from<RecipesRecord>("recipes")
      .join("herbs")
      .where("herbs.slug", "in", ["centella-asiatica"])
      .exec();

    expect(Array.isArray(recipes)).toBe(true);
    expect(recipes.length).toBe(1);
    expect(recipes[0].herbs?.length).toBe(2);
  });
});

describe("QueryBuilder without where", () => {
  it("should return all herbs sorted by default 'slug' index", async () => {
    const { data: herbs, pageInfo } = await staticql
      .from<HerbsRecord>("herbs")
      .exec();
    expect(herbs.map((h) => h.slug)).toEqual([
      "arctium-lappa",
      "centella-asiatica",
      "cymbopogon-citratus",
    ]);
    expect(pageInfo.hasPreviousPage).toBe(false);
    expect(pageInfo.hasNextPage).toBe(false);
    expect(pageInfo.startCursor).toBeDefined();
    expect(pageInfo.endCursor).toBeDefined();
  });
});

describe("QueryBuilder orderBy", () => {
  it("should sort herbs by 'name' ascending", async () => {
    const { data: herbs } = await staticql
      .from<HerbsRecord>("herbs")
      .orderBy("name", "asc")
      .exec();
    expect(herbs.map((h) => h.slug)).toEqual([
      "centella-asiatica",
      "arctium-lappa",
      "cymbopogon-citratus",
    ]);
  });

  it("should sort herbs by 'name' descending", async () => {
    const { data: herbs } = await staticql
      .from<HerbsRecord>("herbs")
      .orderBy("name", "desc")
      .exec();
    expect(herbs.map((h) => h.slug)).toEqual([
      "cymbopogon-citratus",
      "arctium-lappa",
      "centella-asiatica",
    ]);
  });
});

describe("QueryBuilder pagination", () => {
  it("should paginate results with cursors and pageInfo", async () => {
    const first = await staticql
      .from<HerbsRecord>("herbs")
      .orderBy("name", "asc")
      .pageSize(2)
      .exec();
    expect(first.data.map((h) => h.slug)).toEqual([
      "centella-asiatica",
      "arctium-lappa",
    ]);
    expect(first.pageInfo.hasPreviousPage).toBe(false);
    expect(first.pageInfo.hasNextPage).toBe(true);
    expect(first.pageInfo.startCursor).toBeDefined();
    expect(first.pageInfo.endCursor).toBeDefined();

    const second = await staticql
      .from<HerbsRecord>("herbs")
      .orderBy("name", "asc")
      .pageSize(2)
      .cursor(first.pageInfo.endCursor!)
      .exec();
    expect(second.data.map((h) => h.slug)).toEqual(["cymbopogon-citratus"]);
    expect(second.pageInfo.hasPreviousPage).toBe(true);
    expect(second.pageInfo.hasNextPage).toBe(false);
  });
});

describe("QueryBuilder faild where to without index", () => {
  it("should throw when filtering on a non-indexed field", async () => {
    await expect(
      staticql
        .from<HerbsRecord, string>("herbs")
        .where("overview", "eq", "ゴボウの概要")
        .exec()
    ).rejects.toThrow(
      `[herbs] needs index: [{"field":"overview","op":"eq","value":"ゴボウの概要"}]`
    );
  });
});
