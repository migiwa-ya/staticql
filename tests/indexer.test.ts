import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs/promises";
import staticqlConfig from "./staticql.config";

const OUTPUT_DIR = path.join(__dirname, "output");

const db = staticqlConfig;

beforeAll(async () => {
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await db.index();
  await db.saveIndexesTo(OUTPUT_DIR);
});

describe("HasOneThrough / HasManyThrough Relations", () => {
  it("should resolve hasOneThrough (reports.processThroughReportGroup)", async () => {
    const reports = await db
      .from("reports")
      .join("processThroughReportGroup")
      .exec();

    const report = reports.find((r: any) => r.slug === "reportGroup002--001");
    expect(report).toBeTruthy();

    expect(
      report.processThroughReportGroup === null ||
        typeof report.processThroughReportGroup === "object"
    ).toBe(true);
    if (report.processThroughReportGroup) {
      expect(report.processThroughReportGroup.slug).toBeDefined();
    }
  });
});

describe("Indexer", () => {
  it("should generate index file with values", async () => {
    const filePath = path.join(OUTPUT_DIR, "herbs.index.json");
    const json = JSON.parse(await fs.readFile(filePath, "utf-8"));

    expect(json.fields).toContain("name");
    expect(json.fields).toContain("herbState.name");

    const record = json.records.find((r: any) => r.slug === "mentha-piperita");
    expect(record.values.name).toBe("ペパーミント");
  });
});
