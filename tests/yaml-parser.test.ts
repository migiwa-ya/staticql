import { describe, test, expect } from "vitest";
import { parseYAML } from "../src/parser/yaml.js";

describe("parseYAML", () => {
  describe("basic key-value", () => {
    test("simple string value", () => {
      const result = parseYAML({ rawContent: "name: foo" });
      expect(result).toEqual({ name: "foo" });
    });

    test("number value", () => {
      const result = parseYAML({ rawContent: "count: 42" });
      expect(result).toEqual({ count: 42 });
    });

    test("float value", () => {
      const result = parseYAML({ rawContent: "price: 3.14" });
      expect(result).toEqual({ price: 3.14 });
    });

    test("boolean true", () => {
      const result = parseYAML({ rawContent: "active: true" });
      expect(result).toEqual({ active: true });
    });

    test("boolean false", () => {
      const result = parseYAML({ rawContent: "active: false" });
      expect(result).toEqual({ active: false });
    });

    test("null value", () => {
      const result = parseYAML({ rawContent: "value: null" });
      expect(result).toEqual({ value: null });
    });
  });

  describe("values with colons (URL safety)", () => {
    test("URL value", () => {
      const result = parseYAML({ rawContent: "url: https://example.com/path" });
      expect(result).toEqual({ url: "https://example.com/path" });
    });

    test("time value", () => {
      const result = parseYAML({ rawContent: "time: 12:30:00" });
      expect(result).toEqual({ time: "12:30:00" });
    });

    test("multiple colons in value", () => {
      const result = parseYAML({ rawContent: "desc: a:b:c" });
      expect(result).toEqual({ desc: "a:b:c" });
    });
  });

  describe("nested objects", () => {
    test("two-level nesting", () => {
      const rawContent = [
        "parent:",
        "  child: value",
      ].join("\n");
      const result = parseYAML({ rawContent });
      expect(result).toEqual({ parent: { child: "value" } });
    });
  });

  describe("arrays", () => {
    test("inline array", () => {
      const result = parseYAML({ rawContent: "tags: [a, b, c]" });
      expect(result).toEqual({ tags: ["a", "b", "c"] });
    });

    test("block array", () => {
      const rawContent = [
        "items:",
        "  - first",
        "  - second",
      ].join("\n");
      const result = parseYAML({ rawContent });
      expect(result).toEqual({ items: ["first", "second"] });
    });

    test("array of objects", () => {
      const rawContent = [
        "items:",
        "  - name: A",
        "    value: 1",
        "  - name: B",
        "    value: 2",
      ].join("\n");
      const result = parseYAML({ rawContent });
      expect(result).toEqual({
        items: [
          { name: "A", value: 1 },
          { name: "B", value: 2 },
        ],
      });
    });
  });

  describe("array items with URLs", () => {
    test("array of objects containing URL values", () => {
      const rawContent = [
        "links:",
        "  - url: https://example.com",
        "    title: Example",
      ].join("\n");
      const result = parseYAML({ rawContent });
      expect(result).toEqual({
        links: [{ url: "https://example.com", title: "Example" }],
      });
    });
  });

  describe("comments and blank lines", () => {
    test("M1: inline annotations do not become part of an ID", () => {
      const rawContent = [
        "requires:",
        "  - to: AXS-SPC-004          # Place Familiarity",
        "    why: テスト",
      ].join("\n");
      expect(parseYAML({ rawContent })).toEqual({
        requires: [{ to: "AXS-SPC-004", why: "テスト" }],
      });
    });

    test("M2: a comment before a list item preserves the array", () => {
      const rawContent = [
        "requires:",
        "  # Place Familiarity",
        "  - to: AXS-SPC-004",
        "    why: テスト",
      ].join("\n");
      expect(parseYAML({ rawContent })).toEqual({
        requires: [{ to: "AXS-SPC-004", why: "テスト" }],
      });
    });

    test.each([
      ["mapping string", "key: value # c", { key: "value" }],
      ["number", "count: 1 # c", { count: 1 }],
      ["boolean", "active: true # c", { active: true }],
      ["inline array", "tags: [a, b] # c", { tags: ["a", "b"] }],
      ["scalar list", "items:\n  - a # c", { items: ["a"] }],
      ["colon in list comment", "items:\n  - a # note: x", { items: ["a"] }],
      ["root scalar list", "- a # c", ["a"]],
      ["root object list", "- key: v # c", [{ key: "v" }]],
      ["tab before comment", "a: v\t# c", { a: "v" }],
      ["comment-only value", "color: #fff", { color: undefined }],
      ["quote inside plain value", 's: hello, "world # note', { s: 'hello, "world' }],
      ["apostrophe inside plain value", "s: it's # c", { s: "it's" }],
      ["flow continuation comment", "tags: [a, # c\n  b]", { tags: ["a", "b"] }],
      ["plain flow continuation", 'tags: [a\n  "b # c\n  d]', { tags: ['a "b d'] }],
      ["tab before quoted value", 'a:\t"x # y" # c', { a: '"x # y"' }],
      ["no space before quoted value", 'a:"x # y" # c', { a: '"x # y"' }],
      ["tab before list value", '- a:\t"x # y" # c', [{ a: '"x # y"' }]],
    ])("removes inline comments: %s", (_name, rawContent, expected) => {
      expect(parseYAML({ rawContent: rawContent as string })).toEqual(expected);
    });

    test.each([
      ["double quotes", 'a: "x # y"', { a: '"x # y"' }],
      ["single quotes and trailing comment", "b: 'p # q' # r", { b: "'p # q'" }],
      ["hash without preceding space", "a: a#b", { a: "a#b" }],
      ["URL fragment", "url: http://x/#frag", { url: "http://x/#frag" }],
      ["escaped double quote", String.raw`a: "x\" # y"`, { a: String.raw`"x\" # y"` }],
      ["even backslashes close quote", String.raw`a: "x\\" # y`, { a: String.raw`"x\\"` }],
      ["escaped single quote", "a: 'it''s # y'", { a: "'it''s # y'" }],
      ["quoted comment-like continuation", 'tags: ["a\n  # b\n  c"]', { tags: ["a # b c"] }],
      ["quoted inline continuation", 'tags: ["a\n  b # c"]', { tags: ["a b # c"] }],
      ["tab after colon", 'a:\t"x # y"', { a: '"x # y"' }],
      ["no whitespace after colon", 'a:"x # y"', { a: '"x # y"' }],
      ["tab after list key", '- a:\t"x # y"', [{ a: '"x # y"' }]],
      ["new quoted flow element", 'tags: [a,\n  "b # c"]', { tags: ["a", "b # c"] }],
      ["after plain array", 'tags: [a]\nlabel: "x # y"', { tags: ["a"], label: '"x # y"' }],
      ["after plain array with comment", 'tags: [a]\nlabel: "x # y" # c', { tags: ["a"], label: '"x # y"' }],
      ["after quoted array", 'tags: ["a"]\nlabel: "x # y"', { tags: ["a"], label: '"x # y"' }],
      ["after quoted array with comment", 'tags: ["a"]\nlabel: "x # y" # c', { tags: ["a"], label: '"x # y"' }],
      ["after nested array", 'tags: [[a], b]\nlabel: "x # y" # c', { tags: ["[a]", "b"], label: '"x # y"' }],
    ])("preserves literal hashes: %s", (_name, rawContent, expected) => {
      expect(parseYAML({ rawContent: rawContent as string })).toEqual(expected);
    });

    test.each([
      {
        name: "before an object list",
        withComments: "requires:\n  # c\n  - to: AXS-SPC-004\n    why: テスト",
        withoutComments: "requires:\n  - to: AXS-SPC-004\n    why: テスト",
        expected: { requires: [{ to: "AXS-SPC-004", why: "テスト" }] },
      },
      {
        name: "between list items and keys",
        withComments: "items:\n  - name: A\n    # key comment\n    value: 1\n  # item comment\n  - name: B\n    value: 2",
        withoutComments: "items:\n  - name: A\n    value: 1\n  - name: B\n    value: 2",
        expected: { items: [{ name: "A", value: 1 }, { name: "B", value: 2 }] },
      },
      {
        name: "deeply nested list",
        withComments: "parent:\n  # c\n  child:\n    # c\n    items:\n      # c\n      - name: A\n        # c\n        value: 1",
        withoutComments: "parent:\n  child:\n    items:\n      - name: A\n        value: 1",
        expected: { parent: { child: { items: [{ name: "A", value: 1 }] } } },
      },
      {
        name: "root list",
        withComments: "# c\n- name: A\n# c\n- name: B\n# c",
        withoutComments: "- name: A\n- name: B",
        expected: [{ name: "A" }, { name: "B" }],
      },
      {
        name: "multiline inline array",
        withComments: "tags: [a,\n  # c\n  b]\n# c\nname: foo",
        withoutComments: "tags: [a,\n  b]\nname: foo",
        expected: { tags: ["a", "b"], name: "foo" },
      },
      {
        name: "inline array starting on the next line",
        withComments: "tags:\n  # c\n  [a,\n  # c\n  b]",
        withoutComments: "tags:\n  [a,\n  b]",
        expected: { tags: ["a", "b"] },
      },
    ])("comment lines preserve structure: $name", ({ withComments, withoutComments, expected }) => {
      const result = parseYAML({ rawContent: withComments });
      expect(result).toEqual(parseYAML({ rawContent: withoutComments }));
      expect(result).toEqual(expected);
    });

    test("preserves indentation on whitespace-only lines", () => {
      expect(parseYAML({ rawContent: "items:\n  \n  - first" })).toEqual({
        items: ["first"],
      });
    });

    test("lines starting with # are ignored", () => {
      const rawContent = [
        "# this is a comment",
        "name: foo",
        "# another comment",
        "count: 1",
      ].join("\n");
      const result = parseYAML({ rawContent });
      expect(result).toEqual({ name: "foo", count: 1 });
    });

    test("blank lines are skipped", () => {
      const rawContent = [
        "name: foo",
        "",
        "count: 1",
      ].join("\n");
      const result = parseYAML({ rawContent });
      expect(result).toEqual({ name: "foo", count: 1 });
    });
  });

  describe("root-level array", () => {
    test("root-level array of objects", () => {
      const rawContent = [
        "- name: A",
        "- name: B",
      ].join("\n");
      const result = parseYAML({ rawContent });
      expect(result).toEqual([{ name: "A" }, { name: "B" }]);
    });
  });

  describe("empty value", () => {
    test("key with no value returns undefined", () => {
      const rawContent = "key:";
      const result = parseYAML({ rawContent });
      expect(result).toEqual({ key: undefined });
    });
  });
});
