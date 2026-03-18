import { describe, test, expect } from "vitest";
import {
  unwrapSingleArray,
  resolveField,
  extractNestedProperty,
} from "../src/utils/field.js";

describe("unwrapSingleArray", () => {
  test("unwraps deeply nested single-element arrays", () => {
    expect(unwrapSingleArray([[[5]]])).toBe(5);
  });

  test("unwraps single-element array one level", () => {
    expect(unwrapSingleArray([42])).toBe(42);
  });

  test("keeps multi-element array as-is", () => {
    expect(unwrapSingleArray([1, 2])).toEqual([1, 2]);
  });

  test("passes through non-array value", () => {
    expect(unwrapSingleArray("hello")).toBe("hello");
  });

  test("keeps empty array as-is", () => {
    expect(unwrapSingleArray([])).toEqual([]);
  });

  test("passes through null", () => {
    expect(unwrapSingleArray(null)).toBe(null);
  });

  test("passes through undefined", () => {
    expect(unwrapSingleArray(undefined)).toBe(undefined);
  });
});

describe("resolveField", () => {
  test("resolves a simple field", () => {
    expect(resolveField({ name: "foo" }, "name")).toEqual(["foo"]);
  });

  test("resolves nested dot notation", () => {
    expect(resolveField({ a: { b: "val" } }, "a.b")).toEqual(["val"]);
  });

  test("resolves field across array elements", () => {
    const obj = { tags: [{ name: "x" }, { name: "y" }] };
    expect(resolveField(obj, "tags.name")).toEqual(["x", "y"]);
  });

  test("returns empty array for missing field", () => {
    expect(resolveField({ a: 1 }, "b")).toEqual([]);
  });

  test("returns empty array for nested missing field", () => {
    expect(resolveField({ a: { b: 1 } }, "a.c")).toEqual([]);
  });

  test("filters out null values", () => {
    expect(resolveField({ a: null }, "a")).toEqual([]);
  });

  test("stringifies number values", () => {
    expect(resolveField({ count: 42 }, "count")).toEqual(["42"]);
  });

  test("resolves deeply nested path", () => {
    expect(resolveField({ a: { b: { c: "deep" } } }, "a.b.c")).toEqual([
      "deep",
    ]);
  });
});

describe("extractNestedProperty", () => {
  test("extracts property from a single object", () => {
    expect(extractNestedProperty({ a: 1 }, ["a"])).toEqual([1]);
  });

  test("extracts property from array of objects", () => {
    expect(extractNestedProperty([{ a: 1 }, { a: 2 }], ["a"])).toEqual([1, 2]);
  });

  test("extracts nested path", () => {
    expect(extractNestedProperty({ a: { b: 3 } }, ["a", "b"])).toEqual([3]);
  });

  test("filters out null items in results", () => {
    expect(
      extractNestedProperty([{ a: 1 }, { a: null }, { a: 3 }], ["a"])
    ).toEqual([1, 3]);
  });

  test("wraps non-array input automatically", () => {
    const obj = { x: "val" };
    expect(extractNestedProperty(obj, ["x"])).toEqual(["val"]);
  });
});
