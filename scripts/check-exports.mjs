import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const runtimeConditions = ["import", "node", "workerd", "default"];
const packageDir = path.resolve(process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url)));
const failures = [];
const fail = (subpath, reason) => failures.push(`${subpath}: ${reason}`);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Resolve from a consumer directory, so package self-reference cannot hide pack omissions.
const importCode = `
  const [specifier, expectedJSON, privatePath] = process.argv.slice(1);
  try {
    const module = await import(specifier);
    if (privatePath === "true") throw new Error("subpath is still public");
    for (const name of JSON.parse(expectedJSON)) {
      if (typeof module[name] !== "function") throw new Error(name + " is not a function");
    }
  } catch (error) {
    if (privatePath === "true" && error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") process.exit(0);
    console.error(error.code ? error.code + ": " + error.message : error.message);
    process.exit(1);
  }
`;

async function checkPackage() {
  const temp = await mkdtemp(path.join(tmpdir(), "staticql-check-exports-"));
  try {
    const { stdout } = await exec("npm", ["pack", "--pack-destination", temp, "--json"], { cwd: packageDir });
    const [packed] = JSON.parse(stdout);
    const consumer = path.join(temp, "consumer");
    await mkdir(consumer);
    await writeFile(path.join(consumer, "package.json"), JSON.stringify({ type: "module", private: true }));
    await exec("npm", ["install", "--no-audit", "--no-fund", path.join(temp, packed.filename)], { cwd: consumer });
    const installed = path.join(consumer, "node_modules", packed.name);
    const pkg = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
    const exports = pkg.exports;

    async function checkImport(subpath, expected = [], privatePath = false) {
      const specifier = pkg.name + (subpath === "." ? "" : subpath.slice(1));
      try {
        await exec(process.execPath, ["--input-type=module", "-e", importCode, specifier, JSON.stringify(expected), String(privatePath)], { cwd: consumer });
      } catch (error) {
        fail(subpath, error.stderr?.trim() || error.message);
      }
    }

    if (!isObject(exports) || Object.keys(exports).length === 0) {
      fail(".", "unsupported exports format: expected a nonempty subpath map");
    } else {
      for (const [subpath, target] of Object.entries(exports)) {
        if ((subpath !== "." && !subpath.startsWith("./")) || subpath.includes("*")) {
          fail(subpath, "unsupported subpath format or wildcard");
          continue;
        }
        let runtime = false;
        let types;
        if (typeof target === "string") {
          runtime = true;
        } else if (isObject(target)) {
          if (Object.values(target).some((value) => typeof value !== "string")) {
            fail(subpath, "unsupported condition target: expected strings, not nested conditions/null/arrays");
            continue;
          }
          runtime = runtimeConditions.some((condition) => Object.hasOwn(target, condition));
          const typesOnly = Object.keys(target).length === 1 && Object.hasOwn(target, "types");
          if (!runtime && !typesOnly) {
            fail(subpath, "unsupported conditions: no runtime condition and not types-only");
            continue;
          }
          types = target.types;
        } else {
          fail(subpath, "unsupported target format: expected a string or condition object");
          continue;
        }

        if (runtime) {
          const expected = pkg.name === "staticql" && subpath === "./diff/cli" ? ["GitDiffProvider"] : [];
          await checkImport(subpath, expected);
        }
        if (types !== undefined) {
          try {
            if (!types.startsWith("./")) throw new Error("types target must start with ./");
            if (!(await stat(path.join(installed, types))).isFile()) throw new Error("types target is not a file");
          } catch (error) {
            fail(subpath, `types ${types}: ${error.message}`);
          }
        }
      }
    }
    if (pkg.name === "staticql") {
      if (!isObject(exports) || !Object.hasOwn(exports, "./diff/cli")) fail("./diff/cli", "required public subpath is missing");
      if (isObject(exports) && Object.hasOwn(exports, "./diff/fs")) fail("./diff/fs", "must not appear in exports");
      await checkImport("./diff/fs", [], true);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

try {
  await checkPackage();
} catch (error) {
  fail("package", error.stderr?.trim() || error.message);
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log("All package exports passed.");
}
