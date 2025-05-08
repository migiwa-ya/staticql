import { describe, it, expect, vi, beforeAll } from "vitest";
import { defineStaticQL } from "../src/index";
import { FsRepository } from "../src/repository/FsRepository";
import staticqlConfig from "./staticql.config.json";
import { StaticQLConfig } from "../src/StaticQL";
import { HerbsRecord, RecipesRecord } from "./staticql-types";

const config = staticqlConfig as StaticQLConfig;
const staticql = defineStaticQL(config)({
  repository: new FsRepository("tests/"),
});

beforeAll(async () => {
  await staticql.saveIndexes();
});

describe("QueryBuilder with index optimization", () => {
  it("should find herbs by 'eq' match on indexed field", async () => {
    const herbs = await staticql
      .from<HerbsRecord>("herbs")
      .where("slug", "eq", "arctium-lappa")
      .exec();

    expect(Array.isArray(herbs)).toBe(true);
    expect(herbs.length).toBe(1);
    expect(herbs[0]?.name).toBe("ゴボウ");
  });

  it("should find herbs by 'contains' match on indexed relation field", async () => {
    const recipes = await staticql
      .from<RecipesRecord>("recipes")
      .join("herbs")
      .where("herbs.slug", "contains", "centella-asiatica")
      .exec();

    expect(Array.isArray(recipes)).toBe(true);
    expect(recipes.length).toBe(1);
    expect(recipes[0].herbs?.length).toBe(2);
  });
});

describe("QueryBuilder with full scan", () => {
  it("should find herbs by 'eq' match on no indexed field", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const herbs = await staticql
      .from<HerbsRecord>("herbs")
      .where("overview", "eq", "ゴツコラの概要")
      .exec();

    expect(Array.isArray(herbs)).toBe(true);
    expect(herbs.length).toBe(1);
    expect(herbs[0].name).toBe("ゴツゴラ");

    expect(warnSpy).toHaveBeenCalled();
    const warningMessages = warnSpy.mock.calls
      .map((args) => args.join())
      .some((msg) => msg.includes("インデックス未使用"));
    expect(warningMessages).toBe(true);
    warnSpy.mockRestore();
  });
});
