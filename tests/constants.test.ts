import { describe, test, expect } from "vitest";
import {
  getIndexDir,
  getPrefixIndexPath,
  isThroughRelation,
  indexSort,
} from "../src/constants.js";
import type { Relation } from "../src/types.js";

describe("getIndexDir", () => {
  test("returns index dir for sourceName and field", () => {
    expect(getIndexDir("herbs", "name")).toBe("index/herbs.name/");
  });

  test("returns index dir with slug field", () => {
    expect(getIndexDir("herbs", "slug")).toBe("index/herbs.slug/");
  });
});

describe("getPrefixIndexPath", () => {
  test("depth 1, ASCII 'a' returns hex code 0061", () => {
    expect(getPrefixIndexPath("a", 1)).toBe("0061");
  });

  test("depth 1, ASCII 'z' returns hex code 007a", () => {
    expect(getPrefixIndexPath("z", 1)).toBe("007a");
  });

  test("depth 2, 'ab' returns two hex codes joined by slash", () => {
    expect(getPrefixIndexPath("ab", 2)).toBe("0061/0062");
  });

  test("depth 1, longer string 'abc' uses only first char", () => {
    expect(getPrefixIndexPath("abc", 1)).toBe("0061");
  });

  test("Unicode character 'あ' (U+3042) returns 3042", () => {
    expect(getPrefixIndexPath("あ", 1)).toBe("3042");
  });
});

describe("isThroughRelation", () => {
  const throughBase = {
    to: "target",
    through: "intermediate",
    sourceLocalKey: "id",
    throughForeignKey: "source_id",
    throughLocalKey: "id",
    targetForeignKey: "target_id",
  };

  test("hasOneThrough returns true", () => {
    const rel: Relation = { ...throughBase, type: "hasOneThrough" };
    expect(isThroughRelation(rel)).toBe(true);
  });

  test("hasManyThrough returns true", () => {
    const rel: Relation = { ...throughBase, type: "hasManyThrough" };
    expect(isThroughRelation(rel)).toBe(true);
  });

  const directBase = {
    to: "target",
    localKey: "id",
    foreignKey: "target_id",
  };

  test("hasOne returns false", () => {
    const rel: Relation = { ...directBase, type: "hasOne" };
    expect(isThroughRelation(rel)).toBe(false);
  });

  test("hasMany returns false", () => {
    const rel: Relation = { ...directBase, type: "hasMany" };
    expect(isThroughRelation(rel)).toBe(false);
  });

  test("belongsTo returns false", () => {
    const rel: Relation = { ...directBase, type: "belongsTo" };
    expect(isThroughRelation(rel)).toBe(false);
  });
});

describe("indexSort", () => {
  test("default keys sort by v first, then vs", () => {
    type Entry = { v: string; vs: string };
    const sorter = indexSort<Entry>();
    const items: Entry[] = [
      { v: "banana", vs: "x" },
      { v: "apple", vs: "y" },
      { v: "apple", vs: "a" },
    ];
    const sorted = [...items].sort(sorter);
    expect(sorted).toEqual([
      { v: "apple", vs: "a" },
      { v: "apple", vs: "y" },
      { v: "banana", vs: "x" },
    ]);
  });

  test("equal values returns 0", () => {
    type Entry = { v: string; vs: string };
    const sorter = indexSort<Entry>();
    expect(sorter({ v: "a", vs: "b" }, { v: "a", vs: "b" })).toBe(0);
  });

  test("custom keys sorts by specified key order", () => {
    type Entry = { name: string; age: number };
    const sorter = indexSort<Entry>(["name"]);
    const items: Entry[] = [
      { name: "charlie", age: 10 },
      { name: "alice", age: 30 },
      { name: "bob", age: 20 },
    ];
    const sorted = [...items].sort(sorter);
    expect(sorted).toEqual([
      { name: "alice", age: 30 },
      { name: "bob", age: 20 },
      { name: "charlie", age: 10 },
    ]);
  });

  test("non-string comparison with numbers", () => {
    type Entry = { score: number };
    const sorter = indexSort<Entry>(["score"]);
    const items: Entry[] = [{ score: 30 }, { score: 10 }, { score: 20 }];
    const sorted = [...items].sort(sorter);
    expect(sorted).toEqual([{ score: 10 }, { score: 20 }, { score: 30 }]);
  });
});
