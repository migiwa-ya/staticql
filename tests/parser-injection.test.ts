import { describe, it, expect } from "vitest";
import {
  parseByType,
  registerParser,
  Parser,
  ParserOptions,
} from "../src/parser/index.js";
import { defineStaticQL, StaticQLConfig } from "../src/index.js";
import { FsRepository } from "../src/repository/FsRepository.js";
import fs from "fs";
import path from "path";
import os from "os";

// Setup CSV parser injection globally for these tests
const csvParser: Parser = ({ rawContent }) => {
  const text =
    rawContent instanceof Uint8Array
      ? new TextDecoder().decode(rawContent)
      : rawContent;
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(","));
  const headers = lines[0];

  return lines.slice(1).map((cols) => {
    const obj: Record<string, string> = {};
    headers.forEach((header, i) => {
      obj[header] = cols[i];
    });
    return obj;
  });
};
registerParser("csv", csvParser);

describe("Parser Injection", () => {
  it("should parse CSV content when custom parser is registered", async () => {
    const csvText = `col1,col2,col3\n1,2,3\nx,y,z`;
    const result = await parseByType("csv", { rawContent: csvText });
    expect(result).toEqual([
      { col1: "1", col2: "2", col3: "3" },
      { col1: "x", col2: "y", col3: "z" },
    ]);
  });

  it("should build index and peek CSV source with injected parser", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-csv-"));
    const contentDir = path.join(tmp, "content");
    fs.mkdirSync(contentDir, { recursive: true });
    fs.writeFileSync(path.join(contentDir, "sample.csv"), "col1,col2\nfoo,bar");
    const config = {
      sources: {
        csv: {
          type: "csv",
          pattern: "content/*.csv",
          schema: {
            type: "object",
            required: ["col1"],
            properties: {
              col1: { type: "string" },
              col2: { type: "string" },
            },
          },
          index: { col1: {} },
        },
      },
    } as StaticQLConfig;

    const staticql = defineStaticQL(config)({
      repository: new FsRepository(tmp),
      options: { parsers: { csv: csvParser } },
    });
    await staticql.saveIndexes();

    // index directory for slug should be created
    const idxDir = path.join(tmp, "index/");
    const exists = await waitForDirExists(idxDir);
    expect(exists).toBe(true);
  });

  it("should generate _prefixes.jsonl for custom index fields", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-custom-idx-"));
    const contentDir = path.join(tmp, "content");
    fs.mkdirSync(contentDir, { recursive: true });

    // Create multiple CSV files so multiple prefix buckets are generated
    fs.writeFileSync(path.join(contentDir, "alpha.csv"), "col1,col2\nalpha,100");
    fs.writeFileSync(path.join(contentDir, "beta.csv"), "col1,col2\nbeta,200");
    fs.writeFileSync(path.join(contentDir, "gamma.csv"), "col1,col2\ngamma,300");

    const config = {
      sources: {
        items: {
          type: "csv",
          pattern: "content/*.csv",
          schema: {
            type: "object",
            required: ["col1"],
            properties: {
              col1: { type: "string" },
              col2: { type: "string" },
            },
          },
          customIndex: {
            uppercol1: {},
          },
        },
      },
    } as StaticQLConfig;

    const staticql = defineStaticQL(config)({
      repository: new FsRepository(tmp),
      options: { parsers: { csv: csvParser } },
    });

    await staticql.saveIndexes({
      "items.uppercol1": (record) => {
        return record.col1 ? String(record.col1).toUpperCase() : undefined;
      },
    });

    // _prefixes.jsonl must exist for the custom index
    const prefixesPath = path.join(tmp, "index", "items.uppercol1", "_prefixes.jsonl");
    expect(fs.existsSync(prefixesPath)).toBe(true);

    // Verify it contains the expected prefix entries
    const prefixContent = fs.readFileSync(prefixesPath, "utf-8").trim();
    const prefixes = prefixContent.split("\n");
    expect(prefixes.length).toBeGreaterThanOrEqual(1);

    // _index.jsonl files should also exist under prefix directories
    for (const prefix of prefixes) {
      const indexPath = path.join(tmp, "index", "items.uppercol1", prefix, "_index.jsonl");
      expect(fs.existsSync(indexPath)).toBe(true);
    }
  });
});

async function waitForDirExists(
  dir: string,
  timeoutMs = 100,
  intervalMs = 50
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.promises.access(dir, fs.constants.F_OK);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return false;
}
