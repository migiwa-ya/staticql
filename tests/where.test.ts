import { describe, it, expect, beforeAll } from "vitest";
import staticqlConfig from "./staticql.config";
import { HerbsRecord, ReportsRecord } from "./types/staticql-types";

const db = await staticqlConfig;

const OUTPUT_DIR = "tests/output";

beforeAll(async () => {
  await db.saveIndexes(OUTPUT_DIR);
});

describe("QueryBuilder with index optimization", () => {
  it("should find herbs by exact match on indexed field", async () => {
    const result = await db
      .from("herbs")
      .where("name", "eq", "ペパーミント")
      .options({ indexDir: OUTPUT_DIR })
      .exec();

    expect(result.length).toBe(1);
    expect(result[0].slug).toBe("mentha-piperita");
  });

  it("should find herbs by partial match using contains", async () => {
    const result = await db
      .from<HerbsRecord>("herbs")
      .where("name", "contains", "ペパーミント")
      .options({ indexDir: OUTPUT_DIR })
      .exec();

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].name).toContain("ペパーミント");
  });

  it("should find herbs by partial match using in", async () => {
    const result = await db
      .from("herbs")
      .where("tags", "in", ["refresh", "night"])
      .options({ indexDir: OUTPUT_DIR })
      .exec();

    expect(result.length).toBe(2);
  });

  it("should support indexed nested field (herbState.name)", async () => {
    const result = await db
      .from<HerbsRecord>("herbs")
      .join("herbState")
      .where("herbState.name", "eq", "乾燥")
      .options({ indexDir: OUTPUT_DIR })
      .exec();

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.herbState?.name).toBe("乾燥");
  });

  it("should filter reports by joined herb name", async () => {
    const result = await db
      .from<ReportsRecord>("reports")
      .join("herbs")
      .where("herbs.name", "eq", "ペパーミント")
      .options({ indexDir: OUTPUT_DIR })
      .exec();

    expect(result.length).toBe(2);
    expect(result[0]?.herbs![0].slug).toBe("mentha-piperita");
  });
});
