import { SourceConfigResolver } from "../../../src/SourceConfigResolver.js";
import { parsePrefixDict } from "../../../src/utils/normalize.js";
import { joinPath, toI, toP } from "../../../src/utils/path.js";
import type { StorageRepository } from "../../../src/repository/StorageRepository.js";
import { NotFoundError } from "../../../src/repository/errors.js";

type Mode = "A" | "B";
export type AbsencePolicy = "strict" | "lenient" | "manifest";

export interface RepositoryStats {
  paths: string[];
  bytes: number;
  requestedAt: number[];
  scriptUrls: string[];
}

/** Prototype for checking whether StaticQL can read file:// script payloads. */
export class ScriptRepository implements StorageRepository {
  private readonly baseUrl: string;
  private readonly mode: Mode;
  private readonly absence: AbsencePolicy;
  private resolver?: SourceConfigResolver;
  private readonly contents = new Map<string, string>();
  private readonly registered = new Set<string>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly loadedUrls = new Set<string>();
  private readonly requestedAt: number[] = [];
  private bytes = 0;
  private dataLoad?: Promise<void>;
  private manifestLoad?: Promise<void>;
  private manifestPaths?: Set<string>;

  constructor(baseUrl: string, mode: Mode, absence: AbsencePolicy = "strict") {
    this.baseUrl = baseUrl.replace(/\/+$/, "") + "/";
    this.mode = mode;
    this.absence = absence;
  }

  setResolver(resolver: SourceConfigResolver): void {
    this.resolver = resolver;
  }

  register(path: string, content: string): void {
    this.registered.add(path);
    this.contents.set(path, content);
    this.bytes += new TextEncoder().encode(content).byteLength;
    this.requestedAt.push(performance.now());
  }

  registerManifest(paths: string[]): void {
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
      throw new Error("Invalid file-protocol manifest");
    }
    this.manifestPaths = new Set(paths);
    this.registered.add("__manifest__");
  }

  stats(): RepositoryStats {
    return {
      paths: [...this.contents.keys()],
      bytes: this.bytes,
      requestedAt: [...this.requestedAt],
      scriptUrls: [...this.loadedUrls],
    };
  }

  async readFile(path: string): Promise<string> {
    if (this.mode === "A") {
      await this.loadDataMap();
      const content = this.contents.get(path);
      if (content === undefined) throw new NotFoundError(path);
      return content;
    }
    if (this.absence === "manifest") {
      await this.loadManifest();
      if (!this.manifestPaths!.has(path)) throw new NotFoundError(path);
    }
    return this.readFromScript(path);
  }

  async openFileStream(path: string): Promise<ReadableStream> {
    const content = await this.readFile(path);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(content));
        controller.close();
      },
    });
  }

  async exists(path: string): Promise<boolean> {
    if (this.mode === "A") {
      await this.loadDataMap();
      return this.contents.has(path);
    }
    if (this.absence === "manifest") {
      await this.loadManifest();
      if (!this.manifestPaths!.has(path)) return false;
      await this.readFromScript(path);
      return true;
    }
    try {
      await this.readFromScript(path);
      return true;
    } catch (error) {
      if (error instanceof NotFoundError && this.absence === "lenient") return false;
      if (error instanceof NotFoundError) {
        throw new Error(`Cannot confirm whether ${path} is absent: file:// script errors are ambiguous`, { cause: error });
      }
      throw error;
    }
  }

  async listFiles(pattern: string): Promise<string[]> {
    if (this.mode === "A") {
      await this.loadDataMap();
      const regex = globToRegExp(pattern);
      return [...this.contents.keys()].filter((path) => regex.test(path)).sort();
    }

    const source = this.resolver?.resolveAll().find((entry) => pattern.startsWith(entry.pattern));
    if (!source) return [];
    const indexDir = `index/${source.name}.slug`;
    const entries = await this.readAllIndexes(indexDir);
    const slugs = entries.map((entry) => entry.v).filter((slug): slug is string => typeof slug === "string" && slug.length > 0);
    if (pattern.includes("*")) return SourceConfigResolver.getSourcePathsBySlugs(pattern, slugs);
    return slugs.map((slug) => source.pattern.replace("*", slug));
  }

  async writeFile(_path: string, _data: Uint8Array | string): Promise<void> {
    throw new Error("writeFile is not supported by the file-protocol prototype");
  }

  async removeFile(_path: string): Promise<void> {
    throw new Error("removeFile is not supported by the file-protocol prototype");
  }

  async removeDir(_path: string): Promise<void> {
    throw new Error("removeDir is not supported by the file-protocol prototype");
  }

  private async loadDataMap(): Promise<void> {
    this.dataLoad ??= this.loadScript("data.js", "data.js", false).then(() => undefined);
    await this.dataLoad;
  }

  private async loadManifest(): Promise<void> {
    this.manifestLoad ??= this.loadScript("manifest.js", "__manifest__", true).then(() => undefined);
    await this.manifestLoad;
    if (!this.manifestPaths) throw new Error("manifest.js loaded without registering its path list");
  }

  private async readFromScript(path: string): Promise<string> {
    const cached = this.contents.get(path);
    if (cached !== undefined) return cached;
    const existing = this.pending.get(path);
    if (existing) return existing;

    const operation = this.loadScript(`${path}.js`, path, true).finally(() => this.pending.delete(path));
    this.pending.set(path, operation);
    return operation;
  }

  private loadScript(urlPath: string, registeredPath: string, requireRegistration: boolean): Promise<string> {
    const url = new URL(urlPath, this.baseUrl).href;
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      let scriptError: Error | undefined;
      const onWindowError = (event: ErrorEvent) => {
        const executingUrl = (document.currentScript as HTMLScriptElement | null)?.src;
        if ((event.filename && event.filename === url) || executingUrl === url) {
          scriptError = new Error(`Script failed while loading ${url}: ${event.message || "syntax/runtime error"}`);
        }
      };
      window.addEventListener("error", onWindowError);
      script.onerror = () => {
        window.removeEventListener("error", onWindowError);
        const cause = new Error(`Unable to load ${url}`);
        if (this.absence === "manifest" && registeredPath !== "__manifest__" && this.manifestPaths?.has(registeredPath)) {
          reject(new Error(`Existing manifest path failed to load: ${registeredPath}`, { cause }));
        } else {
          reject(new NotFoundError(registeredPath, { cause }));
        }
      };
      script.onload = () => {
        window.removeEventListener("error", onWindowError);
        this.loadedUrls.add(url);
        if (scriptError) {
          reject(scriptError);
          return;
        }
        const content = this.contents.get(registeredPath);
        if (requireRegistration && !this.registered.has(registeredPath)) {
          reject(new Error(`Loaded ${url}, but it did not register ${registeredPath}`));
          return;
        }
        resolve(content ?? "");
      };
      document.head.appendChild(script);
    });
  }

  private async readAllIndexes(dir: string): Promise<Array<{ v?: string; ref?: Record<string, unknown> }>> {
    const lines: Array<{ v?: string; ref?: Record<string, unknown> }> = [];
    const readIndex = async (current: string): Promise<void> => {
      let indexText = "";
      try {
        indexText = await this.readFile(toI(current));
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
      if (indexText.trim()) {
        lines.push(...indexText.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
      }

      let prefixesText = "";
      try {
        prefixesText = await this.readFile(toP(current));
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
      for (const prefix of parsePrefixDict(prefixesText)) {
        await readIndex(joinPath(current, prefix));
      }
    };
    await readIndex(dir);
    return flattenPrefixLines(lines);
  }
}

function flattenPrefixLines(items: Array<{ v?: string; ref?: Record<string, unknown> }>) {
  const seen = new Set<string>();
  const flattened: Array<{ v?: string; ref?: Record<string, unknown> }> = [];
  for (const item of items) {
    for (const key of Object.keys(item.ref ?? {})) {
      if (seen.has(key)) continue;
      seen.add(key);
      flattened.push({ ...item, ref: { [key]: item.ref?.[key] } });
    }
  }
  return flattened;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}
