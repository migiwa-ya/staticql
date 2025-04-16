import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

const configPath = path.join(__dirname, "staticql.config.ts");
const outputPath = path.join(__dirname, "output");
const indexFile = path.join(outputPath, "herbs.meta.json");

describe("CLI generate-index.ts", () => {
  beforeAll(async () => {
    await fs.rm(outputPath, { recursive: true, force: true });

    await exec("tsx", [
      path.resolve("cli/generate-index.ts"),
      configPath,
      outputPath,
    ]);
  });

  it("should generate herbs.meta.json with correct structure", async () => {
    const exists = await fs
      .stat(indexFile)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    const json = JSON.parse(await fs.readFile(indexFile, "utf-8"));
    const allHaveName = Object.values(json).every((item: any) => "name" in item);
    expect(allHaveName).toBe(true);

    expect(json).toHaveProperty("mentha-piperita");
  });
});
