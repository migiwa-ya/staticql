import { describe, expect, test } from "vitest";
import { extractDiff } from "../src/diff/extractDiff.js";
import type { DiffLine, DiffProvider } from "../src/diff/providers/index.js";
import type { StaticQLConfig } from "../src/index.js";

class InMemoryDiffProvider implements DiffProvider {
  constructor(
    private readonly lines: DiffLine[],
    private readonly contents: Map<string, string>
  ) {}

  async diffLines(): Promise<DiffLine[]> {
    return this.lines;
  }

  async gitShow(rev: string, filePath: string): Promise<string> {
    const key = `${rev}:${filePath}`;
    const text = this.contents.get(key);
    if (text === undefined) throw new Error(`Missing fixture: ${key}`);
    return text;
  }
}

function diff(
  status: DiffLine["status"],
  filePath: string,
  pattern: string,
  type: string,
  head?: string,
  base?: string
) {
  const config: StaticQLConfig = {
    sources: {
      pages: {
        type,
        pattern,
        schema: { type: "object" },
        index: { title: {} },
      },
    },
  };
  const contents = new Map<string, string>();
  if (head !== undefined) contents.set(`head:${filePath}`, head);
  if (base !== undefined) contents.set(`base:${filePath}`, base);
  return extractDiff({
    baseRef: "base",
    headRef: "head",
    baseDir: "",
    config,
    diffProvider: new InMemoryDiffProvider([{ status, path: filePath }], contents),
  });
}

function entry(status: DiffLine["status"], slug: string, title: string) {
  return { status, source: "pages", slug, fields: { title: [title], slug } };
}

function modifiedEntry(slug: string, title: string, oldTitle: string) {
  return {
    ...entry("M", slug, title),
    oldFields: { title: [oldTitle], slug },
  };
}

function markdown(slug: string, title: string) {
  return `---\nslug: ${slug}\ntitle: ${title}\n---\nBody`;
}

describe("extractDiff slug consistency (#59)", () => {
  test("(a) overrides an added Markdown slug with the path slug", async () => {
    expect(await diff("A", "content/x.md", "content/*.md", "markdown", markdown("custom", "Title")))
      .toEqual([entry("A", "x", "Title")]);
  });

  test("(b) uses the file name for a single-file source", async () => {
    expect(await diff("A", "content/about.md", "content/about.md", "markdown", markdown("custom", "About")))
      .toEqual([entry("A", "about", "About")]);
  });

  test("(c) overrides the base slug of a deleted record", async () => {
    expect(await diff("D", "content/x.md", "content/*.md", "markdown", undefined, markdown("custom", "Title")))
      .toEqual([entry("D", "x", "Title")]);
  });

  test("(d) emits one modification when base and head slugs differ", async () => {
    expect(await diff("M", "content/x.md", "content/*.md", "markdown", markdown("new", "B"), markdown("old", "A")))
      .toEqual([modifiedEntry("x", "B", "A")]);
  });

  test("(e) overrides the slug of a single YAML object", async () => {
    expect(await diff("A", "data/y.yaml", "data/*.yaml", "yaml", "slug: custom\ntitle: YAML"))
      .toEqual([entry("A", "y", "YAML")]);
  });

  test("(f) preserves each record slug in a YAML array", async () => {
    expect(await diff("A", "data/list.yaml", "data/*.yaml", "yaml", "- slug: a\n  title: A\n- slug: b\n  title: B"))
      .toEqual([entry("A", "a", "A"), entry("A", "b", "B")]);
  });

  test("(g) derives the slug for Markdown without an explicit slug", async () => {
    expect(await diff("A", "content/x.md", "content/*.md", "markdown", "---\ntitle: Title\n---\nBody"))
      .toEqual([entry("A", "x", "Title")]);
  });

  test("(h) emits only the modified record of a YAML array", async () => {
    expect(await diff("M", "data/list.yaml", "data/*.yaml", "yaml",
      "- slug: a\n  title: A2\n- slug: b\n  title: B",
      "- slug: a\n  title: A\n- slug: b\n  title: B"))
      .toEqual([modifiedEntry("a", "A2", "A")]);
  });

  test("(i) emits nothing when only the explicit Markdown slug changes", async () => {
    expect(await diff("M", "content/x.md", "content/*.md", "markdown", markdown("new", "Title"), markdown("old", "Title")))
      .toEqual([]);
  });
});

describe("extractDiff relation-derived fields (#69)", () => {
  test("emits a target modification when only a related indexed field changes", async () => {
    const filePath = "t/a.md";
    const oldText = "---\nslug: a\nname: old\n---\n";
    const newText = "---\nslug: a\nname: updated\n---\n";
    const config: StaticQLConfig = {
      sources: {
        s: {
          type: "markdown",
          pattern: "s/*.md",
          schema: { type: "object" },
          index: { "r.name": {} },
          relations: {
            r: { type: "hasMany", to: "t", localKey: "rel", foreignKey: "slug" },
          },
        },
        t: {
          type: "markdown",
          pattern: "t/*.md",
          schema: { type: "object" },
          index: {},
        },
      },
    };
    const result = await extractDiff({
      baseRef: "base",
      headRef: "head",
      baseDir: "",
      config,
      diffProvider: new InMemoryDiffProvider(
        [{ status: "M", path: filePath }],
        new Map([[`head:${filePath}`, newText], [`base:${filePath}`, oldText]])
      ),
    });

    expect(result).toEqual([{
      status: "M",
      source: "t",
      slug: "a",
      fields: { slug: "a", name: ["updated"] },
      oldFields: { slug: "a", name: ["old"] },
    }]);
  });
});
