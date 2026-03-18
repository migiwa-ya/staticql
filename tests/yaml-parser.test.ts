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
