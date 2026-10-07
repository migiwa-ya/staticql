import { describe, test, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CachedRepository } from "../src/repository/CachedRepository.js";
import { InMemoryCacheProvider } from "../src/cache/InMemoryCacheProvider.js";
import type { CacheProvider } from "../src/cache/CacheProvider.js";
import { FsRepository } from "../src/repository/FsRepository.js";

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
      mock.exists.mockResolvedValueOnce(false);
      expect(await repo.exists("del.txt")).toBe(false);
      expect(mock.exists).toHaveBeenCalledWith("del.txt");
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

function createCacheWithoutClear(): CacheProvider {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      values.set(key, value);
    },
    async has(key: string): Promise<boolean> {
      return values.has(key);
    },
    async delete(key: string): Promise<void> {
      values.delete(key);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.each([
  { name: "InMemoryCacheProvider", createCache: () => new InMemoryCacheProvider() },
  { name: "provider without clear", createCache: createCacheWithoutClear },
])("cache invalidation (#50): $name", ({ createCache }) => {
  const temporaryDirs: string[] = [];

  afterEach(() => {
    for (const dir of temporaryDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createFsRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "staticql-cache-"));
    temporaryDirs.push(dir);
    const inner = new FsRepository(dir);
    await inner.writeFile("d/a.txt", "old");
    return { inner, repo: new CachedRepository(inner, createCache()) };
  }

  test("write invalidates both readFile and openFileStream", async () => {
    const { inner, repo } = await createFsRepo();
    expect(await repo.readFile("d/a.txt")).toBe("old");
    expect(await new Response(await repo.openFileStream("d/a.txt")).text()).toBe("old");

    await repo.writeFile("d/a.txt", "new");

    expect(await repo.readFile("d/a.txt")).toBe("new");
    expect(await repo.readFile("d/a.txt")).toBe(await inner.readFile("d/a.txt"));
    expect(await new Response(await repo.openFileStream("d/a.txt")).text()).toBe("new");
    expect(await repo.exists("d/a.txt")).toBe(true);
  });

  test("write adds a new file to a warmed listing", async () => {
    const { inner, repo } = await createFsRepo();
    expect(await repo.listFiles("d/*.txt")).toEqual(["d/a.txt"]);

    await repo.writeFile("d/b.txt", "new");

    expect((await repo.listFiles("d/*.txt")).sort()).toEqual(["d/a.txt", "d/b.txt"]);
    expect((await repo.listFiles("d/*.txt")).sort()).toEqual((await inner.listFiles("d/*.txt")).sort());
    expect(await repo.readFile("d/b.txt")).toBe("new");
  });

  test("removeFile invalidates content, existence, and listings", async () => {
    const { inner, repo } = await createFsRepo();
    expect(await repo.readFile("d/a.txt")).toBe("old");
    expect(await repo.listFiles("d/*.txt")).toEqual(["d/a.txt"]);

    await repo.removeFile("d/a.txt");

    expect(await repo.listFiles("d/*.txt")).toEqual([]);
    expect(await repo.listFiles("d/*.txt")).toEqual(await inner.listFiles("d/*.txt"));
    expect(await repo.exists("d/a.txt")).toBe(false);
    await expect(repo.readFile("d/a.txt")).rejects.toMatchObject({
      name: "NotFoundError", path: "d/a.txt", cause: { code: "ENOENT" },
    });
    await expect(repo.openFileStream("d/a.txt")).rejects.toMatchObject({
      name: "NotFoundError", path: "d/a.txt", cause: { code: "ENOENT" },
    });
  });

  test("removeDir invalidates cached descendants and listings, including errors", async () => {
    const { inner, repo } = await createFsRepo();
    expect(await repo.readFile("d/a.txt")).toBe("old");
    expect(await repo.listFiles("d/*.txt")).toEqual(["d/a.txt"]);
    expect(await repo.listFiles(".")).toEqual(["d/a.txt"]);

    await repo.removeDir("d");

    expect(await repo.exists("d/a.txt")).toBe(false);
    expect(await repo.exists("d")).toBe(false);
    expect(await repo.listFiles(".")).toEqual(await inner.listFiles("."));
    expect(await repo.listFiles(".")).toEqual([]);
    await expect(inner.listFiles("d/*.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(repo.listFiles("d/*.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(inner.readFile("d/a.txt")).rejects.toMatchObject({
      name: "NotFoundError", path: "d/a.txt", cause: { code: "ENOENT" },
    });
    await expect(repo.readFile("d/a.txt")).rejects.toMatchObject({
      name: "NotFoundError", path: "d/a.txt", cause: { code: "ENOENT" },
    });
    await expect(repo.openFileStream("d/a.txt")).rejects.toMatchObject({
      name: "NotFoundError", path: "d/a.txt", cause: { code: "ENOENT" },
    });
  });

  test("write and removeFile invalidate another spelling of the same path", async () => {
    const { inner, repo } = await createFsRepo();
    expect(await repo.readFile("d/a.txt")).toBe("old");

    await repo.writeFile("./d/a.txt", "new");

    expect(await repo.readFile("d/a.txt")).toBe("new");
    expect(await repo.readFile("d/a.txt")).toBe(await inner.readFile("d/a.txt"));

    await repo.removeFile("./d/a.txt");

    expect(await repo.exists("d/a.txt")).toBe(false);
    await expect(repo.readFile("d/a.txt")).rejects.toMatchObject({
      name: "NotFoundError", path: "d/a.txt", cause: { code: "ENOENT" },
    });
  });

  test("a delayed read cannot cache old content for reads after a write", async () => {
    const oldRead = deferred<string>();
    const readStarted = deferred<void>();
    const inner = createMockRepo({ "a.txt": "new" });
    inner.readFile.mockImplementationOnce(() => {
      readStarted.resolve();
      return oldRead.promise;
    });
    const repo = new CachedRepository(inner, createCache());

    const readA = repo.readFile("a.txt");
    await readStarted.promise;
    await repo.writeFile("a.txt", "new");
    oldRead.resolve("old");
    expect(await readA).toBe("old");

    expect(await repo.readFile("a.txt")).toBe("new");
    expect(await repo.readFile("a.txt")).toBe("new");
    expect(inner.readFile).toHaveBeenCalledTimes(2);
  });

  test("a delayed listing cannot cache an old file list after a write", async () => {
    const oldList = deferred<string[]>();
    const listStarted = deferred<void>();
    const inner = createMockRepo({ "a.txt": "a", "b.txt": "b" });
    inner.listFiles.mockImplementationOnce(() => {
      listStarted.resolve();
      return oldList.promise;
    });
    const repo = new CachedRepository(inner, createCache());

    const listA = repo.listFiles("*.txt");
    await listStarted.promise;
    await repo.writeFile("b.txt", "b");
    oldList.resolve(["a.txt"]);
    expect(await listA).toEqual(["a.txt"]);

    expect(await repo.listFiles("*.txt")).toEqual(["a.txt", "b.txt"]);
    expect(await repo.listFiles("*.txt")).toEqual(["a.txt", "b.txt"]);
    expect(inner.listFiles).toHaveBeenCalledTimes(2);
  });

  test.each([
    {
      name: "readFile",
      read: (repo: CachedRepository) => repo.readFile("a.txt"),
      oldValue: "old",
      newValue: "new",
    },
    {
      name: "openFileStream",
      read: async (repo: CachedRepository) =>
        new Response(await repo.openFileStream("a.txt")).text(),
      oldValue: "old",
      newValue: "new",
    },
    {
      name: "listFiles",
      read: (repo: CachedRepository) => repo.listFiles("*.txt"),
      oldValue: ["a.txt"],
      newValue: ["a.txt", "b.txt"],
    },
  ])("$name handles an evicted cache entry while get is pending", async ({ read, oldValue, newValue }) => {
    const files: Record<string, string> = { "a.txt": "old" };
    const inner = createMockRepo(files);
    inner.writeFile.mockImplementation(async () => {
      files["a.txt"] = "new";
      files["b.txt"] = "added";
    });
    const cache = createCache();
    const repo = new CachedRepository(inner, cache);
    expect(await read(repo)).toEqual(oldValue);

    const getStarted = deferred<void>();
    const resumeGet = deferred<void>();
    const originalGet = cache.get.bind(cache);
    vi.spyOn(cache, "get").mockImplementationOnce(async <T>(key: string) => {
      // In the old implementation, has has already returned true here.
      // Delaying get also exercises the replacement single-get lookup.
      getStarted.resolve();
      await resumeGet.promise;
      return originalGet<T>(key);
    });

    const pendingRead = read(repo);
    await getStarted.promise;
    await repo.writeFile("a.txt", "new");
    resumeGet.resolve();

    expect(await pendingRead).toEqual(newValue);
    expect(await read(repo)).toEqual(newValue);
  });

  test("failed write preserves the original error and invalidates changed content", async () => {
    const files = { "a.txt": "old" };
    const error = new Error("partial write");
    const inner = createMockRepo(files);
    inner.writeFile.mockImplementation(async () => {
      files["a.txt"] = "new";
      throw error;
    });
    const repo = new CachedRepository(inner, createCache());
    expect(await repo.readFile("a.txt")).toBe("old");
    expect(await repo.listFiles("*.txt")).toEqual(["a.txt"]);

    await expect(repo.writeFile("a.txt", "new")).rejects.toBe(error);

    expect(await repo.readFile("a.txt")).toBe("new");
    expect(await repo.readFile("a.txt")).toBe(await inner.readFile("a.txt"));
    expect(await repo.listFiles("*.txt")).toEqual(await inner.listFiles());
  });

  test("failed removeDir invalidates removed files and preserves the original error", async () => {
    const files: Record<string, string> = { "d/a.txt": "old" };
    const error = new Error("partial removal");
    const inner = createMockRepo(files);
    inner.removeDir.mockImplementation(async () => {
      delete files["d/a.txt"];
      throw error;
    });
    const repo = new CachedRepository(inner, createCache());
    expect(await repo.readFile("d/a.txt")).toBe("old");
    expect(await repo.listFiles("d/*.txt")).toEqual(["d/a.txt"]);

    await expect(repo.removeDir("d")).rejects.toBe(error);

    expect(await repo.exists("d/a.txt")).toBe(false);
    expect(await repo.listFiles("d/*.txt")).toEqual([]);
    expect(await repo.listFiles("d/*.txt")).toEqual(await inner.listFiles());
    await expect(repo.readFile("d/a.txt")).rejects.toThrow("Not found: d/a.txt");
  });

  test.each(["set", "delete"] as const)(
    "preserves the inner write error even when cache %s fails during invalidation",
    async (method) => {
      const files = { "a.txt": "old" };
      const innerError = new Error("partial write");
      const cacheError = new Error("cache invalidation failed");
      const inner = createMockRepo(files);
      inner.writeFile.mockImplementation(async () => {
        files["a.txt"] = "new";
        throw innerError;
      });
      const cache = createCache();
      const repo = new CachedRepository(inner, cache);
      expect(await repo.readFile("a.txt")).toBe("old");
      expect(await repo.listFiles("*.txt")).toEqual(["a.txt"]);
      vi.spyOn(cache, method).mockRejectedValueOnce(cacheError);

      await expect(repo.writeFile("a.txt", "new")).rejects.toBe(innerError);

      expect(await repo.readFile("a.txt")).toBe("new");
      expect(await repo.listFiles("*.txt")).toEqual(["a.txt"]);
      expect(inner.listFiles).toHaveBeenCalledTimes(2);
    }
  );

  test.each(["set", "delete"] as const)(
    "reports cache %s failures after a successful write and still invalidates old content",
    async (method) => {
      const files = { "a.txt": "old" };
      const error = new Error("cache invalidation failed");
      const inner = createMockRepo(files);
      inner.writeFile.mockImplementation(async () => { files["a.txt"] = "new"; });
      const cache = createCache();
      const repo = new CachedRepository(inner, cache);
      expect(await repo.readFile("a.txt")).toBe("old");
      vi.spyOn(cache, method).mockRejectedValueOnce(error);

      await expect(repo.writeFile("a.txt", "new")).rejects.toBe(error);

      expect(await repo.readFile("a.txt")).toBe("new");
      expect(inner.writeFile).toHaveBeenCalledTimes(1);
    }
  );

  test("readFile and listFiles still cache unchanged reads", async () => {
    const inner = createMockRepo({ "a.txt": "value" });
    const repo = new CachedRepository(inner, createCache());

    expect(await repo.readFile("a.txt")).toBe("value");
    expect(await repo.readFile("a.txt")).toBe("value");
    expect(await repo.listFiles("*.txt")).toEqual(["a.txt"]);
    expect(await repo.listFiles("*.txt")).toEqual(["a.txt"]);
    expect(inner.readFile).toHaveBeenCalledTimes(1);
    expect(inner.listFiles).toHaveBeenCalledTimes(1);
  });
});
