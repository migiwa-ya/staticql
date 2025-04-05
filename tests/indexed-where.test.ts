import { describe, it, expect, beforeAll } from "vitest";
import staticqlConfig from "./staticql.config";

const db = staticqlConfig;

beforeAll(async () => {
  await db.index();
});

describe("QueryBuilder with index optimization", () => {
  it("should find herbs by exact match on indexed field", async () => {
    const result = await db
      .from("herbs")
      .join("herbState")
      .where("name", "eq", "ペパーミント")
      .exec();

    expect(result.length).toBe(1);
    expect(result[0].slug).toBe("peppermint");
  });

  it("should find herbs by partial match using contains", async () => {
    const result = await db
      .from("herbs")
      .join("herbState")
      .where("name", "contains", "ミント")
      .exec();

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].name).toContain("ミント");
  });

  it("should support indexed nested field (herbState.name)", async () => {
    const result = await db
      .from("herbs")
      .join("herbState")
      .where("herbState.name", "eq", "乾燥")
      .exec();

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].herbState.name).toBe("乾燥");
  });

  it("should filter reports by joined herb name", async () => {
    const result = await db
      .from("reports")
      .join("herb")
      .where("herb.name", "eq", "ペパーミント")
      .exec();

    expect(result.length).toBe(1);
    expect(result[0].slug).toBe("report-001");
    expect(result[0].herb.slug).toBe("peppermint");
  });
});
