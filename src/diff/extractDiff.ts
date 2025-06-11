import path from "path";
import { parseByType } from "../parser/index.js";
import { DiffEntry, StaticQLConfig, Validator } from "../index.js";
import { GitDiffProvider, DiffProvider } from "./providers/index.js";
import {
  SourceConfigResolver as Resolver,
  ResolvedSourceConfig,
} from "../SourceConfigResolver.js";
import { resolveField } from "../utils/field.js";
import { asArray } from "../utils/normalize.js";

export interface ExtractDiffOpts {
  baseRef: string;
  headRef: string;
  baseDir: string;
  config: StaticQLConfig;
  customIndexers?: Record<string, (rec: any) => unknown>;
  validator?: Validator;
  diffProvider?: DiffProvider;
}

export async function extractDiff(opts: ExtractDiffOpts): Promise<DiffEntry[]> {
  const { config, customIndexers = {}, diffProvider } = opts;
  const provider = diffProvider ?? new GitDiffProvider(opts.baseDir);
  const baseRef = opts.baseRef ?? "origin/main";
  const headRef = opts.headRef ?? "HEAD";

  const resolver = new Resolver(config.sources);
  const resolved = resolver.resolveAll();
  const results: DiffEntry[] = [];

  /* -------- helpers -------- */
  const parse = async (text: string, ext: string): Promise<any[]> => {
    if (!text) return [];

    if (ext === ".md") {
      return asArray(await parseByType("markdown", { rawContent: text }));
    }

    if (ext === ".yaml" || ext === ".yml") {
      return asArray(await parseByType("yaml", { rawContent: text }));
    }

    if (ext === ".json") {
      return asArray(await parseByType("json", { rawContent: text }));
    }

    return [];
  };

  /* -------- git diff -------- */
  const diffLines = await provider.diffLines(baseRef, headRef);

  /* -------- main loop ------- */
  for (const line of diffLines) {
    const [stat, filePath] = line.split(/\t/);
    const filePathBase = Resolver.extractBaseDir(
      filePath.replace(/\/$/, "").replace(`${opts.baseDir}`, "")
    ).replace(/^\//, "");

    const rsc = resolved.find((s) => {
      return Resolver.patternTest(s.pattern, filePathBase);
    });

    if (!rsc) continue;

    const ext = path.extname(filePath).toLowerCase();
    const headText: string | null = ["A", "M"].includes(stat)
      ? await provider.gitShow(headRef, filePath)
      : null;
    const baseText: string | null = ["D", "M"].includes(stat)
      ? await provider.gitShow(baseRef, filePath)
      : null;

    const headRecs = headText ? await parse(headText, ext) : [];
    const baseRecs = baseText ? await parse(baseText, ext) : [];

    headRecs.forEach((rec) => {
      if (!rec.slug) {
        rec.slug = Resolver.getSlugFromPath(rsc.pattern, filePathBase);
      }
    });
    baseRecs.forEach((rec) => {
      if (!rec.slug) {
        rec.slug = Resolver.getSlugFromPath(rsc.pattern, filePathBase);
      }
    });

    if (stat === "A") headRecs.forEach((rec) => emit("A", rec, rsc));
    if (stat === "D") baseRecs.forEach((rec) => emit("D", rec, rsc));
    if (stat === "M") processModified(headRecs, baseRecs, rsc);
  }

  return results;

  /* ===== local fns ============================================= */

  function buildFields(rec: any, rsc: ResolvedSourceConfig) {
    const out: Record<string, unknown> = {};

    for (const key of Object.keys(rsc.indexes ?? {})) {
      const customKey = `${rsc.name}.${key}`;
      const customFn = customIndexers[customKey];

      if (customFn) {
        // customIndex
        out[key] = customFn(rec);
      } else {
        // index / relation localKey
        out[key] = resolveField(rec, key);
      }
    }

    return out;
  }

  function emit(
    status: "A" | "D" | "M",
    rec: any,
    rsc: ResolvedSourceConfig,
    oldRec?: any
  ) {
    const fields = buildFields(rec, rsc);

    if (
      status === "M" &&
      oldRec &&
      JSON.stringify(fields) === JSON.stringify(buildFields(oldRec, rsc))
    )
      return;

    // slug as String for src/Indexer.ts:getStatus
    fields["slug"] = rec.slug;

    results.push({ status, source: rsc.name, slug: rec.slug, fields });
  }

  function processModified(
    head: any[],
    base: any[],
    rsc: ResolvedSourceConfig
  ) {
    const hm = new Map(head.map((r) => [r.slug, r]));
    const bm = new Map(base.map((r) => [r.slug, r]));

    for (const s of hm.keys()) if (!bm.has(s)) emit("A", hm.get(s), rsc);
    for (const s of bm.keys()) if (!hm.has(s)) emit("D", bm.get(s), rsc);
    for (const s of hm.keys())
      if (bm.has(s)) emit("M", hm.get(s), rsc, bm.get(s));
  }
}
