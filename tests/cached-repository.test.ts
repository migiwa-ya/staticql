import { describe, test, expect, vi } from "vitest";
import { CachedRepository } from "../src/repository/CachedRepository.js";
import { InMemoryCacheProvider } from "../src/cache/InMemoryCacheProvider.js";

function createMockRepo(files: Record<string, string>) {
  return {
    readFile: vi.fn(async (path: string) => {
      if (files[path]) return files[path];
      throw new Error(`Not found: ${path}`);
    }),
    openFileStream: vi.fn(),
    exists: vi.fn(async (path: string) => path in files),
    listFiles: vi.fn(async () => Object.keys(files)),
    writeFile: vi.fn(async () => {}),
    removeFile: vi.fn(async () => {}),
    removeDir: vi.fn(async () => {}),
  };
}

describe("CachedRepository", () => {
  describe("readFile", () => {
    test("first call fetches from inner, second call returns from cache (inner called only once)", async () => {
      const mock = createMockRepo({ "a.txt": "hello" });
      const cache = new InMemoryCacheProvider();
      const repo = new CachedRepository(mock, cache);

      const first = await repo.readFile("a.txt");
      const second = await repo.readFile("a.txt");

      expect(first).toBe("hello");
      expect(second).toBe("hello");
      expect(mock.readFile).toHaveBeenCalledTimes(1);
    });

    test("returns correct content for different files", async () => {
      const mock = createMockRepo({ "a.txt": "aaa", "b.txt": "bbb" });
      const cache = new InMemoryCacheProvider();
      const repo = new CachedRepository(mock, cache);

      const a = await repo.readFile("a.txt");
      const b = await repo.readFile("b.txt");

      expect(a).toBe("aaa");
      expect(b).toBe("bbb");
      expect(mock.readFile).toHaveBeenCalledTimes(2);
    });
  });

  describe("openFileStream", () => {
    test("returns a ReadableStream with correct content", async () => {
      const mock = createMockRepo({ "file.md": "stream content" });
      const cache = new InMemoryCacheProvider();
      const repo = new CachedRepository(mock, cache);

      const stream = await repo.openFileStream("file.md");
      const text = await new Response(stream).text();

      expect(text).toBe("stream content");
    });

    test("uses cache on second call (inner.readFile called only once)", async () => {
      const mock = createMockRepo({ "file.md": "cached stream" });
      const cache = new InMemoryCacheProvider();
      const repo = new CachedRepository(mock, cache);

      const stream1 = await repo.openFileStream("file.md");
      const text1 = await new Response(stream1).text();

      const stream2 = await repo.openFileStream("file.md");
      const text2 = await new Response(stream2).text();

      expect(text1).toBe("cached stream");
      expect(text2).toBe("cached stream");
      expect(mock.readFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("exists", () => {
    test("returns true when file is cached (without calling inner)", async () => {
      const mock = createMockRepo({ "x.txt": "data" });
      const cache = new InMemoryCacheProvider();
      const repo = new CachedRepository(mock, cache);

      // Populate cache via readFile
      await repo.readFile("x.txt");
      mock.exists.mockClear();

      const result = await repo.exists("x.txt");

      expect(result).toBe(true);
      expect(mock.exists).not.toHaveBeenCalled();
    });

    test("delegates to inner.exists when not cached", async () => {
      const mock = createMockRepo({ "y.txt": "data" });
      const cache = new InMemoryCacheProvider();
      const repo = new CachedRepository(mock, cache);

      const exists = await repo.exists("y.txt");
      const notExists = await repo.exists("z.txt");

      expect(exists).toBe(true);
      expect(notExists).toBe(false);
      expect(mock.exists).toHaveBeenCalledTimes(2);
    });
  });

  describe("listFiles", () => {
    test("first call fetches from inner and caches", async () => {
      const mock = createMockRepo({ "a.ts": "a", "b.ts": "b" });
      const cache = new InMemoryCacheProvider();
      const repo = new CachedRepository(mock, cache);

      const files = await repo.listFiles("*.ts");

      expect(files).toEqual(["a.ts", "b.ts"]);
      expect(mock.listFiles).toHaveBeenCalledTimes(1);
    });

    test("second call returns from cache", async () => {
      const mock = createMockRepo({ "a.ts": "a", "b.ts": "b" });
      const cache = new InMemoryCacheProvider();
      const repo = new CachedRepository(mock, cache);

      const first = await repo.listFiles("*.ts");
      const second = await repo.listFiles("*.ts");

      expect(first).toEqual(["a.ts", "b.ts"]);
      expect(second).toEqual(["a.ts", "b.ts"]);
      expect(mock.listFiles).toHaveBeenCalledTimes(1);
    });
  });

  describe("removeFile", () => {
    test("clears cache entry and delegates to inner", async () => {
      const mock = createMockRepo({ "del.txt": "to delete" });
      const cache = new InMemoryCacheProvider();
      const repo = new CachedRepository(mock, cache);

      // Populate cache
      await repo.readFile("del.txt");
      expect(mock.readFile).toHaveBeenCalledTimes(1);

      await repo.removeFile("del.txt");

      expect(mock.removeFile).toHaveBeenCalledWith("del.txt");
      // Cache should be cleared, so exists should delegate to inner
      expect(await cache.has("file:del.txt")).toBe(false);
    });
  });

  describe("writeFile", () => {
    test("delegates directly to inner", async () => {
      const mock = createMockRepo({});
      const cache = new InMemoryCacheProvider();
      const repo = new CachedRepository(mock, cache);

      await repo.writeFile("out.txt", "content");

      expect(mock.writeFile).toHaveBeenCalledWith("out.txt", "content");
      expect(mock.writeFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("removeDir", () => {
    test("delegates directly to inner", async () => {
      const mock = createMockRepo({});
      const cache = new InMemoryCacheProvider();
      const repo = new CachedRepository(mock, cache);

      await repo.removeDir("some/dir");

      expect(mock.removeDir).toHaveBeenCalledWith("some/dir");
      expect(mock.removeDir).toHaveBeenCalledTimes(1);
    });
  });
});
