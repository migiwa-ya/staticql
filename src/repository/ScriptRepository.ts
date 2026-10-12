import { SourceConfigResolver } from "../SourceConfigResolver.js";
import { parsePrefixDict } from "../utils/normalize.js";
import { joinPath, toI, toP } from "../utils/path.js";
import type { StorageRepository } from "./StorageRepository.js";
import { NotFoundError } from "./errors.js";

export type ScriptAbsencePolicy = "lenient" | "manifest";

export interface ScriptRepositoryOptions {
  absence?: ScriptAbsencePolicy;
}

interface ScriptRegistrationApi {
  register(path: string, content: string): void;
  registerManifest(paths: string[]): void;
}

declare global {
  var __STATICQL_SCRIPT__: ScriptRegistrationApi | undefined;
}

const scriptOwners = new WeakMap<HTMLScriptElement, ScriptRepository>();
let latestRepository: ScriptRepository | undefined;

function activeScriptRepository(): ScriptRepository | undefined {
  const currentScript = document.currentScript;
  return (currentScript && scriptOwners.get(currentScript as HTMLScriptElement)) || latestRepository;
}

/**
 * Reads file:// payload scripts. In the default lenient mode, a script load
 * failure is treated as absence; this can also hide permission or other load
 * failures. Use manifest mode when absence must be distinguished reliably.
 */
export class ScriptRepository implements StorageRepository {
  private readonly baseUrl: string;
  private readonly absence: ScriptAbsencePolicy;
  private resolver?: SourceConfigResolver;
  private readonly contents = new Map<string, string>();
  private readonly registered = new Set<string>();
  private readonly pending = new Map<string, Promise<string>>();
  private manifestLoad?: Promise<void>;
  private manifestPaths?: Set<string>;

  constructor(baseUrl: string, options: ScriptRepositoryOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "") + "/";
    this.absence = options.absence ?? "lenient";
    latestRepository = this;
    globalThis.__STATICQL_SCRIPT__ = {
      register(path, content) {
        activeScriptRepository()?.register(path, content);
      },
      registerManifest(paths) {
        activeScriptRepository()?.registerManifest(paths);
      },
    };
  }

  setResolver(resolver: SourceConfigResolver): void {
    this.resolver = resolver;
  }

  register(path: string, content: string): void {
    this.registered.add(path);
    this.contents.set(path, content);
  }

  registerManifest(paths: string[]): void {
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
      throw new Error("Invalid file-protocol manifest");
    }
    this.manifestPaths = new Set(paths);
    this.registered.add("__manifest__");
  }

  async readFile(path: string): Promise<string> {
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
      throw error;
    }
  }

  async listFiles(pattern: string): Promise<string[]> {
    const source = this.resolver?.resolveAll().find((entry) => pattern.startsWith(entry.pattern));
    if (!source) return [];

    const entries = await this.readAllIndexes(`index/${source.name}.slug`);
    const slugs = entries
      .map((entry) => entry.v)
      .filter((slug): slug is string => typeof slug === "string" && slug.length > 0);
    const paths = pattern.includes("*")
      ? SourceConfigResolver.getSourcePathsBySlugs(pattern, slugs)
      : slugs.map((slug) => source.pattern.replace("*", slug));
    return [...new Set(paths)];
  }

  async writeFile(_path: string, _data: Uint8Array | string): Promise<void> {
    throw new Error("writeFile is not supported by ScriptRepository");
  }

  async removeFile(_path: string): Promise<void> {
    throw new Error("removeFile is not supported by ScriptRepository");
  }

  async removeDir(_path: string): Promise<void> {
    throw new Error("removeDir is not supported by ScriptRepository");
  }

  private async loadManifest(): Promise<void> {
    this.manifestLoad ??= this.loadScript("manifest.js", "__manifest__", true).then(() => undefined);
    await this.manifestLoad;
    if (!this.manifestPaths) throw new Error("manifest.js loaded without registering its path list");
  }

  private readFromScript(path: string): Promise<string> {
    const cached = this.contents.get(path);
    if (cached !== undefined) return Promise.resolve(cached);
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
      scriptOwners.set(script, this);
      let scriptError: Error | undefined;

      const removeWindowErrorListener = () => window.removeEventListener("error", onWindowError);
      const finish = () => {
        removeWindowErrorListener();
        scriptOwners.delete(script);
      };
      const onWindowError = (event: ErrorEvent) => {
        const executingUrl = (document.currentScript as HTMLScriptElement | null)?.src;
        if ((event.filename && event.filename === url) || executingUrl === url) {
          scriptError = new Error(`Script failed while loading ${url}: ${event.message || "syntax/runtime error"}`);
        }
      };

      window.addEventListener("error", onWindowError);
      script.onerror = () => {
        finish();
        const cause = new Error(`Unable to load ${url}`);
        if (this.absence === "manifest" && registeredPath !== "__manifest__" && this.manifestPaths?.has(registeredPath)) {
          reject(new Error(`Existing manifest path failed to load: ${registeredPath}`, { cause }));
        } else {
          reject(new NotFoundError(registeredPath, { cause }));
        }
      };
      script.onload = () => {
        finish();
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
