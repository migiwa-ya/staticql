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
  const parse = async (
    text: string | null,
    ext: string
  ): Promise<{ records: any[]; isArray: boolean }> => {
    const type = ext === ".md" ? "markdown"
      : ext === ".yaml" || ext === ".yml" ? "yaml"
      : ext === ".json" ? "json" : null;
    if (!text || !type) return { records: [], isArray: false };

    const parsed = await parseByType(type, { rawContent: text });
    return { records: asArray(parsed), isArray: Array.isArray(parsed) };
  };

  /* -------- git diff -------- */
  const diffLines = await provider.diffLines(baseRef, headRef);

  /* -------- main loop ------- */
  for (const { status: stat, path: filePath } of diffLines) {
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

    const { records: headRecs, isArray: headIsArray } = await parse(headText, ext);
    const { records: baseRecs, isArray: baseIsArray } = await parse(baseText, ext);

    headRecs.forEach((rec) => {
      if (!headIsArray || !rec.slug) {
        rec.slug = Resolver.getSlugFromPath(rsc.pattern, filePathBase);
      }
    });
    baseRecs.forEach((rec) => {
      if (!baseIsArray || !rec.slug) {
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
    const oldFields = oldRec ? buildFields(oldRec, rsc) : undefined;

    if (
      status === "M" &&
      oldRec &&
      JSON.stringify(fields) === JSON.stringify(oldFields)
    )
      return;

    // slug as String for src/Indexer.ts:getStatus
    fields["slug"] = rec.slug;
    if (oldFields) oldFields["slug"] = rec.slug;

    results.push({
      status,
      source: rsc.name,
      slug: rec.slug,
      fields,
      ...(status === "M" && oldFields ? { oldFields } : {}),
    });
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
