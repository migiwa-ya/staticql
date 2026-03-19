import { describe, test, expect } from "vitest";
import { simpleValidate } from "../src/validator/simpleValidate.js";

describe("simpleValidate", () => {
  describe("primitives", () => {
    test("string passes", () => {
      expect(() => simpleValidate("hello", { type: "string" })).not.toThrow();
    });

    test("number passes", () => {
      expect(() => simpleValidate(42, { type: "number" })).not.toThrow();
    });

    test("integer passes", () => {
      expect(() => simpleValidate(3, { type: "integer" })).not.toThrow();
    });

    test("boolean passes", () => {
      expect(() => simpleValidate(true, { type: "boolean" })).not.toThrow();
    });

    test("type mismatch throws", () => {
      expect(() => simpleValidate("hello", { type: "number" })).toThrow();
    });
  });

  describe("null handling", () => {
    test("null allowed with union type", () => {
      expect(() => simpleValidate(null, { type: ["string", "null"] })).not.toThrow();
    });

    test("null not allowed throws", () => {
      expect(() => simpleValidate(null, { type: "string" })).toThrow();
    });
  });

  describe("arrays", () => {
    test("valid array passes", () => {
      expect(() => simpleValidate([1, 2], { type: "array", items: { type: "number" } })).not.toThrow();
    });

    test("array item type mismatch throws", () => {
      expect(() => simpleValidate([1, "x"], { type: "array", items: { type: "number" } })).toThrow();
    });

    test("non-array when array expected throws", () => {
      expect(() => simpleValidate("hello", { type: "array" })).toThrow();
    });
  });

  describe("objects", () => {
    test("valid object passes", () => {
      expect(() =>
        simpleValidate({ name: "test" }, { type: "object", properties: { name: { type: "string" } } })
      ).not.toThrow();
    });

    test("missing required field throws", () => {
      expect(() =>
        simpleValidate({}, { type: "object", required: ["name"], properties: { name: { type: "string" } } })
      ).toThrow();
    });

    test("extra fields are OK", () => {
      expect(() =>
        simpleValidate({ name: "test", extra: 123 }, { type: "object", properties: { name: { type: "string" } } })
      ).not.toThrow();
    });
  });

  describe("union types", () => {
    test('["string", "number"] accepts string', () => {
      expect(() => simpleValidate("hello", { type: ["string", "number"] })).not.toThrow();
    });

    test('["string", "number"] accepts number', () => {
      expect(() => simpleValidate(42, { type: ["string", "number"] })).not.toThrow();
    });

    test('["string", "number"] rejects boolean', () => {
      expect(() => simpleValidate(true, { type: ["string", "number"] })).toThrow();
    });
  });

  describe("no schema type", () => {
    test("no type means no validation", () => {
      expect(() => simpleValidate("anything", {})).not.toThrow();
    });
  });

  describe("date type", () => {
    test("valid date string passes", () => {
      expect(() => simpleValidate("2024-01-01", { type: "date" })).not.toThrow();
    });

    test("invalid date string throws", () => {
      expect(() => simpleValidate("not-a-date", { type: "date" })).toThrow();
    });
  });
});
