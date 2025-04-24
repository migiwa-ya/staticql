import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs/promises";
import staticqlConfig from "./staticql.config";
import { FileSystemProvider } from "../src/storage/FileSystemProvider";

const OUTPUT_DIR = "tests/output";

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
  it("should resolve hasMany relation with array foreignKey (herbs.reports)", async () => {
    const herbs = await db.from("herbs").join("reports").exec();
    const chamomile = herbs.find(
      (h: any) => h.slug === "matricaria-chamomilla"
    );
    expect(chamomile).toBeTruthy();
    expect(Array.isArray(chamomile.reports)).toBe(true);
    // Should contain all related reports (check at least one known slug)
    const reportSlugs = chamomile.reports.map((r: any) => r.slug);
    expect(reportSlugs.length).toBeGreaterThan(0);
    expect(reportSlugs).toContain("reportGroup001--001");
  });

  it("should output correct meta for dot notation (reports.reportGroupSlug)", async () => {
    const metaPath = path.join(OUTPUT_DIR, "herbs.meta.json");
    const provider = new FileSystemProvider();
    const raw = await provider.readFile(metaPath);
    let meta: string[];
    if (raw instanceof Uint8Array) {
      meta = JSON.parse(new TextDecoder().decode(raw));
    } else {
      meta = JSON.parse(raw);
    }
    const chamomileMeta = meta["matricaria-chamomilla"];
    expect(chamomileMeta).toBeTruthy();
    // reports.reportGroupSlug should be a flat array of all reportGroupSlugs from related reports
    expect(Array.isArray(chamomileMeta["reports.reportGroupSlug"])).toBe(true);
    expect(chamomileMeta["reports.reportGroupSlug"].length).toBeGreaterThan(0);
    // Should contain a known reportGroupSlug
    expect(chamomileMeta["reports.reportGroupSlug"]).toContain(
      "reportGroup001"
    );
  });
});
