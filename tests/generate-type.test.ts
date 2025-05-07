import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

const typeFilename = "staticql-types.d.ts";
const configPath = "tests/staticql.config.json";
const outputPath = "tests/";

beforeAll(async () => {
  await exec("tsx", [
    path.resolve("cli/generate-types.ts"),
    configPath,
    outputPath,
  ]);
});

describe("generate-types", () => {
  it("generates HerbsRecord with relation fields", () => {
    const content = fs.readFileSync(outputPath + typeFilename, "utf-8");

    expect(content).toMatch(/export type HerbsRecord = /);
    expect(content).toMatch(/name: string;/);
    expect(content).toMatch(/tagSlugs: string\[]/);
    expect(content).toMatch(/herbs\?: HerbsRecord\[]/);
    expect(content).toMatch(/recipes\?: RecipesRecord\[];/);
  });

  it("generates HerbsRelation_recipes as Record<string, string[]>", () => {
    const content = fs.readFileSync(outputPath + typeFilename, "utf-8");
    expect(content).toMatch(
      /export type HerbsRelation_recipes = Record<string, string\[]>;/
    );
  });

  it("generates RecipesRecord with relation fields", () => {
    const content = fs.readFileSync(outputPath + typeFilename, "utf-8");
    expect(content).toMatch(/herbs\?: HerbsRecord\[];/);
    expect(content).toMatch(/process\?: ProcessesRecord;/);
  });
});
