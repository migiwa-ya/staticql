import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import path, { dirname } from "path";
import os from "os";
import { fileURLToPath } from "url";

// emulate __dirname in ESM
const __dirname = dirname(fileURLToPath(import.meta.url));

const CLI_PATH = path.resolve(__dirname, "../cli/generate-index.ts");
const CONFIG_FILE = path.resolve(__dirname, "staticql.config.json");
const SAMPLE_CONTENT = path.resolve(__dirname, "content");
const EXPECTED_INDEX = path.resolve(__dirname, "index");

/**
 * Read all files under a directory recursively and return a map of relative paths to content.
 */
/**
 * Read a prefix index directory and parse each file as JSON Lines,
 * returning a map of relative paths to array of objects (sorted deterministically).
 */
function readIndexRecords(dir: string): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  function walk(current: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name !== "_prefixes.jsonl") {
        const lines = fs.readFileSync(full, "utf-8").split(/\r?\n/).filter(Boolean);
        const objs = lines.map((l) => JSON.parse(l));
        objs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        result[rel] = objs;
      }
    }
  }
  walk(dir);
  return result;
}

describe("generate-index CLI", () => {
  it("errors on missing arguments", () => {
    const res = spawnSync("tsx", [CLI_PATH], { encoding: "utf-8" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Error: Expected at least 2 arguments");
  });

  it("errors on incremental without diff-file flag", () => {
    // prepare temp directory only for flags test
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-"));
    const cfg = path.join(tmp, "staticql.config.json");
    fs.copyFileSync(CONFIG_FILE, cfg);
    const res = spawnSync(
      "tsx",
      [CLI_PATH, cfg, tmp, "--incremental"],
      { encoding: "utf-8" }
    );
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Error: --incremental requires --diff-file=");
  });

  it("generates full index matching expected snapshot", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-"));
    fs.cpSync(SAMPLE_CONTENT, path.join(tmp, "content"), { recursive: true });
    const cfg = path.join(tmp, "staticql.config.json");
    fs.copyFileSync(CONFIG_FILE, cfg);

    const expected = readIndexRecords(EXPECTED_INDEX);

    const res = spawnSync(
      "tsx",
      [CLI_PATH, cfg, tmp],
      { encoding: "utf-8" }
    );
    expect(res.status).toBe(0);
    const actual = readIndexRecords(path.join(tmp, "index"));
    expect(actual).toEqual(expected);
  });
});