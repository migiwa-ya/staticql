import { afterEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../scripts/check-exports.mjs", import.meta.url));
const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function check(exports: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-exports-fixture-"));
  temporaryDirs.push(dir);
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "exports-fixture",
    version: "1.0.0",
    type: "module",
    files: ["dist"],
    exports,
  }));
  fs.writeFileSync(path.join(dir, "dist/index.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(dir, "dist/index.d.ts"), "export declare const value: number;\n");
  const result = spawnSync(process.execPath, [checker, dir], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("packed package exports checker (#52)", () => {
  test("(j) accepts string, runtime+types, and types-only targets", () => {
    const result = check({
      "./string": "./dist/index.js",
      "./conditional": { import: "./dist/index.js", types: "./dist/index.d.ts" },
      "./types": { types: "./dist/index.d.ts" },
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain("All package exports passed.");
  });

  test("(k) rejects a missing string target with its subpath", () => {
    const result = check({ "./broken": "./dist/missing.js" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("./broken:");
    expect(result.output).toContain("ERR_MODULE_NOT_FOUND");
  });

  test("(l) rejects a missing types-only target with its subpath", () => {
    const result = check({ "./types": { types: "./dist/missing.d.ts" } });
    expect(result.status).toBe(1);
    expect(result.output).toContain("./types:");
    expect(result.output).toContain("types ./dist/missing.d.ts");
  });

  test("(m) reports each unsupported target instead of skipping it", () => {
    const result = check({
      "./array": ["./dist/index.js"],
      "./unknown": { browser: "./dist/index.js" },
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("./array: unsupported target format");
    expect(result.output).toContain("./unknown: unsupported conditions");
  });
});
