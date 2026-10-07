import { afterEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineStaticQL, type StaticQLConfig } from "../src/index.js";
import { FsRepository } from "../src/repository/FsRepository.js";
import { SourceConfigResolver } from "../src/SourceConfigResolver.js";
import type { PrefixIndexLine } from "../src/utils/typs.js";

describe("single-file sources (#51)", () => {
  const temporaryDirs: string[] = [];

  afterEach(() => {
    for (const dir of temporaryDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    { name: "without an explicit slug", frontmatter: "title: About" },
    { name: "with a different explicit slug", frontmatter: "title: About\nslug: custom" },
  ])("uses the file name for queries and indexes $name", async ({ frontmatter }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-single-file-"));
    temporaryDirs.push(dir);
    const repository = new FsRepository(dir);
    await repository.writeFile("content/about.md", `---\n${frontmatter}\n---\nAbout page`);
    const config: StaticQLConfig = {
      sources: {
        pages: {
          type: "markdown",
          pattern: "content/about.md",
          schema: {
            type: "object",
            properties: { title: { type: "string" }, slug: { type: "string" } },
            required: ["title", "slug"],
          },
          index: { slug: {} },
        },
      },
    };
    const staticql = defineStaticQL(config)({ repository });

    expect(await repository.listFiles("content/about.md")).toEqual(["content/about.md"]);
    await staticql.saveIndexes();

    const result = await staticql.from("pages").exec();
    expect(result.data.map((record) => record.slug)).toEqual(["about"]);
    expect((await staticql.from("pages").find("about"))?.slug).toBe("about");

    const indexFiles = (await repository.listFiles("index/pages.slug"))
      .filter((file) => path.basename(file) === "_index.jsonl");
    expect(indexFiles).toHaveLength(1);
    const lines = (await Promise.all(indexFiles.map((file) => repository.readFile(file))))
      .flatMap((content) => content.split("\n").filter(Boolean))
      .map((line) => JSON.parse(line) as PrefixIndexLine);
    expect(lines.map((line) => line.v)).toEqual(["about"]);
  });

  test.each([
    { pattern: "content/about.md", filePath: "content/about.md", expected: "about" },
    { pattern: "about.md", filePath: "about.md", expected: "about" },
    { pattern: "content/*.md", filePath: "content/x.md", expected: "x" },
  ])("derives $expected from $pattern and $filePath", ({ pattern, filePath, expected }) => {
    expect(SourceConfigResolver.getSlugFromPath(pattern, filePath)).toBe(expected);
  });
});
