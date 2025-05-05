import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

const typeFilename = "staticql-types.d.ts";
const configPath = "tests/staticql.config.ts";
const outputPath = "tests/types/";

describe("generate-types", () => {
  beforeAll(async () => {
    // Run the type generation script before tests
    console.log(path.resolve("cli/generate-types.ts"))
    await exec("tsx", [
      path.resolve("cli/generate-types.ts"),
      configPath,
      outputPath,
    ]);
  });

  it("generates HerbsRecord with relation fields", () => {
    const content = fs.readFileSync(outputPath + typeFilename, "utf-8");
    expect(content).toMatch(/export type HerbsRecord = /);
    expect(content).toMatch(/name: string;/);
    expect(content).toMatch(/tags: string\[]/);
    // Relation fields
    expect(content).toMatch(/herbState\?: HerbStatesRecord;/);
    expect(content).toMatch(/reports\?: ReportsRecord\[];/);
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
});
