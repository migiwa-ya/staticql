import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceConfigResolver } from "../src/SourceConfigResolver.js";
import { FetchRepository } from "../src/repository/FetchRepository.js";

const sourceConfig = {
  p: {
    type: "markdown",
    pattern: "p/*.md",
    schema: { type: "object" as const },
    index: { slug: {} },
  },
};
const rootIndex = "/index/p.slug/_index.jsonl";
const rootPrefixes = "/index/p.slug/_prefixes.jsonl";
const childIndex = "/index/p.slug/child/_index.jsonl";
const childPrefixes = "/index/p.slug/child/_prefixes.jsonl";
const indexLine = (slug: string) => JSON.stringify({ v: slug, vs: slug, ref: { [slug]: 1 } });

afterEach(() => {
  vi.unstubAllGlobals();
});

function repository() {
  const repository = new FetchRepository();
  repository.setResolver(new SourceConfigResolver(sourceConfig));
  return repository;
}

function stubFetch(files: Record<string, string | { status: number }>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = String(input);
    const response = files[path];
    if (response === undefined) return new Response(null, { status: 404 });
    if (typeof response === "object") return new Response(null, { status: response.status });
    return new Response(response);
  }));
}

describe("FetchRepository.listFiles remote index reads", () => {
  it.each([403, 503])("rejects when _index.jsonl responds with HTTP %s", async (status) => {
    stubFetch({ [rootIndex]: { status } });

    await expect(repository().listFiles("p/*.md")).rejects.toThrow(`HTTP ${status}`);
  });

  it.each([403, 503])("rejects when _prefixes.jsonl responds with HTTP %s", async (status) => {
    stubFetch({ [rootIndex]: "", [rootPrefixes]: { status } });

    await expect(repository().listFiles("p/*.md")).rejects.toThrow(`HTTP ${status}`);
  });

  it.each([rootIndex, rootPrefixes])("rejects a network failure from %s", async (failedPath) => {
    const failure = new TypeError("network unavailable");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) === failedPath) throw failure;
      if (String(input) === rootIndex) return new Response("");
      return new Response(null, { status: 404 });
    }));

    await expect(repository().listFiles("p/*.md")).rejects.toBe(failure);
  });

  it("rejects malformed JSON in _index.jsonl", async () => {
    stubFetch({ [rootIndex]: "{invalid json}" });

    await expect(repository().listFiles("p/*.md")).rejects.toThrow(SyntaxError);
  });

  it("treats a missing _index.jsonl as an absent file when prefixes exist", async () => {
    stubFetch({ [rootIndex]: { status: 404 }, [rootPrefixes]: "" });

    await expect(repository().listFiles("p/*.md")).resolves.toEqual([]);
  });

  it("returns index entries when _prefixes.jsonl is missing", async () => {
    stubFetch({ [rootIndex]: indexLine("a"), [rootPrefixes]: { status: 404 } });

    await expect(repository().listFiles("p/*.md")).resolves.toEqual(["p/a.md"]);
  });

  it("treats both missing index files as an absent directory", async () => {
    stubFetch({ [rootIndex]: { status: 404 }, [rootPrefixes]: { status: 404 } });

    await expect(repository().listFiles("p/*.md")).resolves.toEqual([]);
  });

  it("keeps existing entries when a listed child directory is missing", async () => {
    stubFetch({
      [rootIndex]: indexLine("root"),
      [rootPrefixes]: "child",
      [childIndex]: { status: 404 },
      [childPrefixes]: { status: 404 },
    });

    await expect(repository().listFiles("p/*.md")).resolves.toEqual(["p/root.md"]);
  });

  it("rejects a 503 instead of returning an empty file list", async () => {
    stubFetch({ [rootIndex]: { status: 503 } });

    await expect(repository().listFiles("p/*.md")).rejects.toThrow("HTTP 503");
  });
});
