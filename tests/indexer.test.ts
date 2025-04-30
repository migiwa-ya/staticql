import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs/promises";
import define from "./staticql.config";
import { FileSystemProvider } from "../src/storage/FileSystemProvider";
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

  it("should output correct meta for dot notation (reports.reportGroupSlug)", async () => {
    const metaPath = path.join(OUTPUT_DIR, "/meta/herbs.meta.json");
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
