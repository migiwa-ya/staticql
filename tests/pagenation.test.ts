import { describe, test, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  getPageSlice,
  createPageInfo,
  CursorObject,
} from "../src/utils/pagenation.js";

describe("encodeCursor / decodeCursor", () => {
  test("roundtrip with ASCII slug returns original object", () => {
    const obj: CursorObject = { slug: "my-post", order: { date: "2024-01-01" } };
    const encoded = encodeCursor(obj);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(obj);
  });

  test("roundtrip with Unicode slug (Japanese characters)", () => {
    const obj: CursorObject = { slug: "ゴボウの育て方", order: { name: "あいう" } };
    const encoded = encodeCursor(obj);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(obj);
  });

  test("decodeCursor throws 'Invalid cursor' for invalid base64 string", () => {
    expect(() => decodeCursor("not-valid-base64!!!")).toThrow("Invalid cursor");
  });

  test("decodeCursor throws 'Invalid cursor' for empty string", () => {
    expect(() => decodeCursor("")).toThrow("Invalid cursor");
  });
});

describe("getPageSlice", () => {
  const records = ["a", "b", "c", "d", "e", "f", "g", "h"];

  test("direction 'after', startIndex 0 returns first pageSize items", () => {
    const result = getPageSlice(records, 0, 3, "after");
    expect(result).toEqual(["a", "b", "c"]);
  });

  test("direction 'after', startIndex > 0 skips startIndex+1 items", () => {
    // startIndex=2, so skip index 0..2 (3 items), return from index 3
    const result = getPageSlice(records, 2, 3, "after");
    expect(result).toEqual(["d", "e", "f"]);
  });

  test("direction 'before' returns items before startIndex", () => {
    // endIdx=6, beginIdx=6-3=3, slice(3,6) => ["d","e","f"]
    const result = getPageSlice(records, 6, 3, "before");
    expect(result).toEqual(["d", "e", "f"]);
  });

  test("direction 'before', startIndex near beginning clamps to 0", () => {
    // endIdx=2, beginIdx=max(0, 2-5)=0, slice(0,2) => ["a","b"]
    const result = getPageSlice(records, 2, 5, "before");
    expect(result).toEqual(["a", "b"]);
  });

  test("empty records array returns empty array", () => {
    const result = getPageSlice([], 0, 3, "after");
    expect(result).toEqual([]);
  });
});

describe("createPageInfo", () => {
  const encode = (item: string) => item;

  test("first page (startIndex=0, after): hasPreviousPage=false, hasNextPage=true when more items exist", () => {
    const page = ["a", "b", "c"];
    const info = createPageInfo(page, 3, 0, 10, "after", encode);
    expect(info.hasPreviousPage).toBe(false);
    expect(info.hasNextPage).toBe(true);
    expect(info.startCursor).toBe("a");
    expect(info.endCursor).toBe("c");
  });

  test("first page with exact fit: hasNextPage=false", () => {
    const page = ["a", "b", "c"];
    const info = createPageInfo(page, 3, 0, 3, "after", encode);
    expect(info.hasPreviousPage).toBe(false);
    expect(info.hasNextPage).toBe(false);
  });

  test("middle page: both hasPreviousPage and hasNextPage are true", () => {
    // startIndex=3 (>0), so offset = 3+1=4, hasNext = 4+3<10 = true, hasPrev = 4>0 = true
    const page = ["d", "e", "f"];
    const info = createPageInfo(page, 3, 3, 10, "after", encode);
    expect(info.hasPreviousPage).toBe(true);
    expect(info.hasNextPage).toBe(true);
    expect(info.startCursor).toBe("d");
    expect(info.endCursor).toBe("f");
  });

  test("last page: hasNextPage=false", () => {
    // startIndex=6 (>0), offset=7, hasNext = 7+3<10 = false, hasPrev = 7>0 = true
    const page = ["h", "i", "j"];
    const info = createPageInfo(page, 3, 6, 10, "after", encode);
    expect(info.hasNextPage).toBe(false);
    expect(info.hasPreviousPage).toBe(true);
  });

  test("empty page: cursors are undefined", () => {
    const page: string[] = [];
    const info = createPageInfo(page, 3, 0, 0, "after", encode);
    expect(info.startCursor).toBeUndefined();
    expect(info.endCursor).toBeUndefined();
    expect(info.hasNextPage).toBe(false);
    expect(info.hasPreviousPage).toBe(false);
  });

  test("before direction: first page from the end", () => {
    // endIdx=10, beginIdx=max(0,10-3)=7, hasNext=10<10=false, hasPrev=7>0=true
    const page = ["h", "i", "j"];
    const info = createPageInfo(page, 3, 10, 10, "before", encode);
    expect(info.hasNextPage).toBe(false);
    expect(info.hasPreviousPage).toBe(true);
    expect(info.startCursor).toBe("h");
    expect(info.endCursor).toBe("j");
  });

  test("before direction: middle page", () => {
    // endIdx=6, beginIdx=max(0,6-3)=3, hasNext=6<10=true, hasPrev=3>0=true
    const page = ["d", "e", "f"];
    const info = createPageInfo(page, 3, 6, 10, "before", encode);
    expect(info.hasNextPage).toBe(true);
    expect(info.hasPreviousPage).toBe(true);
  });

  test("before direction: reaching the beginning", () => {
    // endIdx=3, beginIdx=max(0,3-3)=0, hasNext=3<10=true, hasPrev=0>0=false
    const page = ["a", "b", "c"];
    const info = createPageInfo(page, 3, 3, 10, "before", encode);
    expect(info.hasNextPage).toBe(true);
    expect(info.hasPreviousPage).toBe(false);
  });
});
