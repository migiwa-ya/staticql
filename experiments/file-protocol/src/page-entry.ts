import { defineStaticQL, type StaticQLConfig } from "../../../src/index.js";
import { NotFoundError } from "../../../src/repository/errors.js";
import { ScriptRepository, type AbsencePolicy } from "./ScriptRepository.js";
import { executeC4Query, type QueryInputs } from "./scenarios.js";

declare global {
  interface Window {
    __sq: {
      register(path: string, content: string): void;
      run(inputs: QueryInputs, absence: AbsencePolicy): Promise<unknown>;
      runC4(mode: "A" | "B", kind: "Q-index" | "Q-relation", inputs: QueryInputs, absence: AbsencePolicy): Promise<unknown>;
      observeErrors(absence: AbsencePolicy): Promise<unknown>;
      NotFoundError: typeof NotFoundError;
      registerManifest(paths: string[]): void;
    };
  }
}

const config = JSON.parse(document.documentElement.dataset.config ?? "{}") as StaticQLConfig;
let activeRepository: ScriptRepository | undefined;

window.__sq = {
  register(path, content) {
    activeRepository?.register(path, content);
  },
  registerManifest(paths) {
    activeRepository?.registerManifest(paths);
  },
  async run(inputs, absence) {
    const repository = new ScriptRepository(new URL("./", location.href).href, "B", absence);
    activeRepository = repository;
    const staticql = defineStaticQL(config)({ repository });
    const result: Record<string, unknown> = {};
    const scenarios = [
      ["S-index", () => staticql.from("herbs").where("name", "eq", inputs.name).exec()],
      ["S-custom", () => staticql.from("herbs").where("nameUpper", "eq", inputs.nameUpper).exec()],
      ["S-relation", () => staticql.from("recipes").join("herbs").where("herbs.slug", "in", [inputs.herbSlug]).exec()],
      ["S-through", () => staticql.from("recipes").join("process").exec()],
      ["S-list", () => staticql.from("herbs").exec()],
    ] as const;
    for (const [name, operation] of scenarios) {
      try {
        result[name] = { status: "resolved", value: await operation() };
      } catch (error) {
        result[name] = {
          status: "rejected",
          name: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { result, stats: repository.stats() };
  },
  async runC4(mode, kind, inputs, absence) {
    const repository = new ScriptRepository(new URL("./", location.href).href, mode, absence);
    activeRepository = repository;
    const staticql = defineStaticQL(config)({ repository });
    const started = performance.now();
    let result: unknown;
    let error: { name: string; message: string } | undefined;
    try {
      result = await executeC4Query(staticql, kind, inputs);
    } catch (caught) {
      error = {
        name: caught instanceof Error ? caught.name : "unknown",
        message: caught instanceof Error ? caught.message : String(caught),
      };
    }
    const elapsedMs = performance.now() - started;
    return { result, error, elapsedMs, stats: repository.stats() };
  },
  async observeErrors(absence) {
    const repository = new ScriptRepository(new URL("./", location.href).href, "B", absence);
    activeRepository = repository;
    const output: Record<string, unknown> = {};
    for (const [key, operation] of Object.entries({
      missingRead: () => repository.readFile("missing.txt"),
      brokenRead: () => repository.readFile("broken.txt"),
      deniedRead: () => repository.readFile("denied.txt"),
      missingExists: () => repository.exists("missing.txt"),
      deniedExists: () => repository.exists("denied.txt"),
    })) {
      try {
        const value = await operation();
        output[key] = { status: "resolved", value };
      } catch (error) {
        output[key] = {
          status: "rejected",
          name: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : String(error),
          isNotFound: error instanceof NotFoundError,
        };
      }
    }
    return output;
  },
  NotFoundError,
};
