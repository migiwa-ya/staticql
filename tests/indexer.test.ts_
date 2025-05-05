import { describe, it, expect, beforeAll } from "vitest";
import define from "./staticql.config";
import { ReportsRecord, HerbsRecord } from "./types/staticql-types.js";

const OUTPUT_DIR = "tests/public";

const staticql = define();

beforeAll(async () => {
  // await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await staticql.saveIndexes();
});

describe("HasOneThrough / HasManyThrough Relations", () => {
  it("should resolve hasOneThrough (reports.processThroughReportGroup)", async () => {
    const reports = await staticql
      .from<ReportsRecord>("reports")
      .join("processThroughReportGroup")
      .exec();
    expect(reports).toBeTruthy();

    const report = reports.find((r: any) => r.slug === "reportGroup002--001");
    expect(report).toBeTruthy();
    expect(typeof report?.processThroughReportGroup === "object").toBe(true);
    expect(report?.processThroughReportGroup!.slug).toBe("tincture");
  });
});

describe("Indexer", () => {
  it("should resolve hasMany relation with array foreignKey (herbs.reports)", async () => {
    const herbs = await staticql
      .from<HerbsRecord>("herbs")
      .join("reports")
      .where("slug", "eq", "matricaria-chamomilla")
      .exec();

    const chamomile = herbs.find((h) => h.slug === "matricaria-chamomilla");
    expect(chamomile).toBeTruthy();
    expect(Array.isArray(chamomile!.reports)).toBe(true);
    if (!chamomile?.reports) return;
    const reportSlugs = chamomile!.reports.map((r) => r.slug);
    expect(reportSlugs.length).toBeGreaterThan(0);
    expect(reportSlugs).toContain("reportGroup001--001");
  });
});
