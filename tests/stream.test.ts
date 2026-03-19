import { describe, test, expect } from "vitest";
import { readJsonlStream, readListStream } from "../src/utils/stream.js";

function toStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) results.push(item);
  return results;
}

describe("readJsonlStream", () => {
  test("parses single JSON line", async () => {
    const stream = toStream('{"a":1}\n');
    const reader = stream.getReader();
    const results = await collect(readJsonlStream(reader, new TextDecoder()));
    expect(results).toEqual([{ a: 1 }]);
  });

  test("parses multiple JSON lines", async () => {
    const stream = toStream('{"a":1}\n{"b":2}\n');
    const reader = stream.getReader();
    const results = await collect(readJsonlStream(reader, new TextDecoder()));
    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("handles trailing content without newline", async () => {
    const stream = toStream('{"a":1}');
    const reader = stream.getReader();
    const results = await collect(readJsonlStream(reader, new TextDecoder()));
    expect(results).toEqual([{ a: 1 }]);
  });

  test("skips empty lines", async () => {
    const stream = toStream('{"a":1}\n\n{"b":2}\n');
    const reader = stream.getReader();
    const results = await collect(readJsonlStream(reader, new TextDecoder()));
    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("empty stream returns nothing", async () => {
    const stream = toStream("");
    const reader = stream.getReader();
    const results = await collect(readJsonlStream(reader, new TextDecoder()));
    expect(results).toEqual([]);
  });
});

describe("readListStream", () => {
  test("reads single line", async () => {
    const stream = toStream("hello\n");
    const reader = stream.getReader();
    const results = await collect(readListStream(reader, new TextDecoder()));
    expect(results).toEqual(["hello"]);
  });

  test("reads multiple lines", async () => {
    const stream = toStream("a\nb\nc\n");
    const reader = stream.getReader();
    const results = await collect(readListStream(reader, new TextDecoder()));
    expect(results).toEqual(["a", "b", "c"]);
  });

  test("handles trailing content without newline", async () => {
    const stream = toStream("hello");
    const reader = stream.getReader();
    const results = await collect(readListStream(reader, new TextDecoder()));
    expect(results).toEqual(["hello"]);
  });

  test("skips empty lines", async () => {
    const stream = toStream("a\n\nb\n");
    const reader = stream.getReader();
    const results = await collect(readListStream(reader, new TextDecoder()));
    expect(results).toEqual(["a", "b"]);
  });

  test("empty stream returns nothing", async () => {
    const stream = toStream("");
    const reader = stream.getReader();
    const results = await collect(readListStream(reader, new TextDecoder()));
    expect(results).toEqual([]);
  });
});
