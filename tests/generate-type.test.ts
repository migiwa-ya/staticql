import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

const typeFilename = "staticql-types.d.ts";
const configPath = path.join(__dirname, "staticql.config.ts");
const outputPath = path.join(__dirname, "types/");

describe("generate-types", () => {
  beforeAll(async () => {
    // Run the type generation script before tests
    await exec("tsx", [
      path.resolve("cli/generate-types.ts"),
      configPath,
      outputPath,
    ]);
  });

  it("generates HerbsRecord with relation fields", () => {
    const content = fs.readFileSync(outputPath + typeFilename, "utf-8");
    expect(content).toMatch(/export type HerbsRecord = \{\s*slug: string;/);
    expect(content).toMatch(/name: string;/);
    expect(content).toMatch(/tags: string\[];/);
    // Relation fields
    expect(content).toMatch(/herbState\?: HerbStatesRecord;/);
    expect(content).toMatch(/reports\?: ReportsRecord\[];/);
  });

  it("generates HerbsMeta with correct nested types", () => {
    const content = fs.readFileSync(outputPath + typeFilename, "utf-8");
    // Top-level
    expect(content).toMatch(/"name": string;/);
    expect(content).toMatch(/"tags": string\[];/);
    // Nested
    expect(content).toMatch(/"herbState\.name"\?: string;/);
    expect(content).toMatch(/"reports\.reportGroupSlug"\?: string\[];/);
  });

  it("generates HerbsRelation_reports as Record<string, string[]>", () => {
    const content = fs.readFileSync(outputPath + typeFilename, "utf-8");
    expect(content).toMatch(
      /export type HerbsRelation_reports = Record<string, string\[]>;/
    );
  });

  it("generates ReportsRecord with relation fields", () => {
    const content = fs.readFileSync(outputPath + typeFilename, "utf-8");
    expect(content).toMatch(/herbs\?: HerbsRecord\[];/);
    expect(content).toMatch(/processThroughReportGroup\?: ProcessesRecord;/);
  });

  it("generates ReportsMeta with correct nested types", () => {
    const content = fs.readFileSync(outputPath + typeFilename, "utf-8");
    console.log(content)
    expect(content).toMatch(/"herbs\.name"\?: string\[];/);
    expect(content).toMatch(/"processThroughReportGroup\.name"\?: string;/);
  });
});
