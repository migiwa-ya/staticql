/**
 * File protocol repository feasibility prototype (not a supported API).
 *
 * Run from the repository root with:
 *   npx --no-install tsx experiments/file-protocol/run.ts
 *
 * Requires the existing node_modules tree and headless Chromium at
 * /usr/bin/chromium. The run stages tests/content in a private temporary
 * directory, builds an index and local file:// payloads, then prints C1-C4
 * observations. Read each comparison as measured evidence for this Chromium
 * version and dataset; differences are recorded, not treated as a test pass.
 * Firefox/Safari, R2/gzip, production error handling, and API design remain
 * unverified. This is a prototype only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { defineStaticQL, type StaticQLConfig } from "../../src/index.js";
import { FsRepository } from "../../src/repository/FsRepository.js";
import { executeC4Query, executeScenarios, type QueryInputs } from "./src/scenarios.js";

const projectRoot = "/home/nagisa/projects/staticql-issue-41-file-protocol-verification";
const experimentRoot = `${projectRoot}/experiments/file-protocol`;
const chromiumPath = "/usr/bin/chromium";
const sampleCount = 5;
const defaultSyntheticCount = 500;
const originalConfigPath = `${projectRoot}/tests/staticql.config.json`;
const sourceContent = `${projectRoot}/tests/content`;

interface Dataset {
  name: string;
  root: string;
  config: StaticQLConfig;
  inputs: QueryInputs;
  logicalFileCount: number;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: CdpMessage): void; reject(error: Error): void }>();
  private readonly events = new Map<string, Array<(message: CdpMessage) => void>>();
  private readonly latestEvents = new Map<string, CdpMessage>();
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? "CDP command failed"));
        else pending.resolve(message);
      } else if (message.method) {
        this.latestEvents.set(message.method, message);
        for (const callback of this.events.get(message.method) ?? []) callback(message);
      }
    });
    socket.addEventListener("close", () => {
      for (const item of this.pending.values()) item.reject(new Error("CDP websocket closed"));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Unable to connect to Chromium DevTools")), { once: true });
    });
    return new CdpClient(socket);
  }

  on(method: string, callback: (message: CdpMessage) => void): () => void {
    const list = this.events.get(method) ?? [];
    list.push(callback);
    this.events.set(method, list);
    return () => this.events.set(method, list.filter((entry) => entry !== callback));
  }

  latest(method: string): CdpMessage | undefined {
    return this.latestEvents.get(method);
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    const id = this.nextId++;
    const response = new Promise<CdpMessage>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  close(): void {
    this.socket.close();
  }
}

async function main(): Promise<void> {
  await fs.access(chromiumPath);
  await fs.access(`${projectRoot}/node_modules/tsx`);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "staticql-file-protocol-"));
  const browserProfiles = new Set<string>();
  const children = new Set<ChildProcess>();
  try {
    const config = await loadConfig();
    const fixture = await prepareFixture(tempRoot, config);
    const syntheticCount = Math.max(5, Number.parseInt(process.argv[2] ?? String(defaultSyntheticCount), 10));
    if (!Number.isSafeInteger(syntheticCount) || syntheticCount < 5) {
      throw new Error("Synthetic herb count must be an integer of at least 5");
    }
    const synthetic = await prepareSynthetic(tempRoot, config, syntheticCount);

    await generatePayloads(fixture.root, ["broken.txt", "denied.txt"]);
    await generatePayloads(synthetic.root);
    await fs.writeFile(path.join(fixture.root, "probe.js"), "window.__sqProbeLoaded = true;");
    await fs.writeFile(path.join(fixture.root, "broken.txt.js"), "window.__sq = ;");
    await fs.writeFile(path.join(fixture.root, "denied.txt.js"), "window.__sqDeniedLoaded = true;");
    await fs.chmod(path.join(fixture.root, "denied.txt.js"), 0o000);

    const bundlePath = path.join(tempRoot, "page-entry.js");
    await build({
      entryPoints: [path.join(experimentRoot, "src/page-entry.ts")],
      outfile: bundlePath,
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "es2020",
    });
    for (const dataset of [fixture, synthetic]) await writePage(dataset.root, dataset.config, bundlePath);

    const nodeExpected = await expectedScenarios(fixture);
    const c1c2c3 = await runObservations(fixture, children, browserProfiles);
    const c4 = await runMeasurements([fixture, synthetic], children, browserProfiles);

    const output = {
      prototype: "file:// ScriptRepository feasibility observations",
      environment: { chromium: chromiumPath, syntheticHerbs: syntheticCount },
      C1: c1c2c3.C1,
      C2: c1c2c3.C2,
      C3: c1c2c3.C3,
      C4: c4,
      limitations: [
        "Firefox and Safari were not tested.",
        "R2Repository, gzip, writes, and production API design are out of scope.",
        "Chromium script error events do not reliably distinguish an absent file from access denial; see C3.",
        "The lenient absence policy can misclassify access denial as absence.",
        "The manifest policy reads the complete path list in advance; manifest size grows with the number of logical files.",
      ],
      decisionGuidance: "Use the measured query result equality, loaded-script count, generated-JS bytes, and timings to decide whether a follow-on implementation merits design work.",
    };
    output.C2 = c1c2c3.C2;
    output.C4 = c4;
    // Keep the Node reference present in the output summary without dumping all
    // fixture records twice; this verifies every named scenario was evaluated.
    output.C2 = { ...output.C2, nodeScenarioNames: Object.keys(nodeExpected) };
    console.log(JSON.stringify(output, null, 2));
  } finally {
    for (const child of children) await terminate(child);
    for (const profile of browserProfiles) await fs.rm(profile, { recursive: true, force: true });
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function loadConfig(): Promise<StaticQLConfig> {
  const parsed = JSON.parse(await fs.readFile(originalConfigPath, "utf8")) as StaticQLConfig;
  parsed.sources.herbs!.customIndex = { nameUpper: {} };
  return parsed;
}

async function prepareFixture(tempRoot: string, config: StaticQLConfig): Promise<Dataset> {
  const root = path.join(tempRoot, "fixture");
  await fs.cp(sourceContent, path.join(root, "content"), { recursive: true });
  await buildIndexes(root, config);
  return {
    name: "fixture",
    root,
    config,
    inputs: { name: "ゴボウ", nameUpper: "ゴボウ", herbSlug: "centella-asiatica" },
    logicalFileCount: await countFiles(root),
  };
}

async function prepareSynthetic(tempRoot: string, config: StaticQLConfig, count: number): Promise<Dataset> {
  const root = path.join(tempRoot, "synthetic");
  await fs.cp(sourceContent, path.join(root, "content"), { recursive: true });
  const herbsDir = path.join(root, "content/herbs");
  const recipesDir = path.join(root, "content/recipes");
  await fs.rm(herbsDir, { recursive: true, force: true });
  await fs.rm(recipesDir, { recursive: true, force: true });
  await fs.mkdir(herbsDir, { recursive: true });
  await fs.mkdir(recipesDir, { recursive: true });

  const slugs: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const slug = `synthetic-herb-${String(index + 1).padStart(4, "0")}`;
    const name = index === 0 ? "Synthetic Target Herb" : `Synthetic Herb ${String(index + 1).padStart(4, "0")}`;
    slugs.push(slug);
    const body = `---\nname: ${name}\ncompoundSlugs: []\ntagSlugs: [antioxidant]\noverview: Synthetic fixture record ${index + 1}\n---\n\nSynthetic content ${index + 1}\n`;
    await fs.writeFile(path.join(herbsDir, `${slug}.md`), body);
  }

  const groupCount = Math.max(2, Math.ceil(count / 5));
  const groupRecords: string[] = [];
  for (let index = 0; index < groupCount; index += 1) {
    const groupSlug = `syntheticGroup${String(index + 1).padStart(4, "0")}`;
    const herbSlug = slugs[Math.min(index * 5, slugs.length - 1)]!;
    groupRecords.push(`- slug: ${groupSlug}\n  processSlug: infusion\n  combinedHerbs:\n    - slug: ${herbSlug}\n      herbStateSlug: dry\n      herbPartSlug: leaf`);
    const groupDir = path.join(recipesDir, groupSlug);
    await fs.mkdir(groupDir, { recursive: true });
    await fs.writeFile(path.join(groupDir, "001.md"), `---\nrecipeGroupSlug: ${groupSlug}\nrecipe:\n  - Add ${herbSlug}\n  - Steep in hot water\n---\n\nSynthetic recipe ${index + 1}\n`);
  }
  await fs.writeFile(path.join(root, "content/recipeGroups.yaml"), `${groupRecords.join("\n\n")}\n`);
  await buildIndexes(root, config);
  return {
    name: `synthetic-${count}`,
    root,
    config,
    inputs: { name: "Synthetic Target Herb", nameUpper: "SYNTHETIC TARGET HERB", herbSlug: slugs[0]! },
    logicalFileCount: await countFiles(root),
  };
}

async function buildIndexes(root: string, config: StaticQLConfig): Promise<void> {
  const staticql = defineStaticQL(config)({ repository: new FsRepository(root) });
  await staticql.saveIndexes({
    "herbs.nameUpper": (record) => String(record.name ?? "").toUpperCase(),
  });
}

async function expectedScenarios(dataset: Dataset) {
  const repository = new FsRepository(dataset.root);
  const staticql = defineStaticQL(dataset.config)({ repository });
  return executeScenarios(staticql, dataset.inputs);
}

async function generatePayloads(root: string, extraLogicalPaths: string[] = []): Promise<void> {
  const files = await recursiveFiles(root);
  const entries: Array<[string, string]> = [];
  for (const absolutePath of files) {
    const relative = path.relative(root, absolutePath).split(path.sep).join("/");
    entries.push([relative, await fs.readFile(absolutePath, "utf8")]);
  }
  const dataBody = entries.map(([name, content]) => `window.__sq.register(${JSON.stringify(name)},${JSON.stringify(content)});`).join("\n");
  await fs.writeFile(path.join(root, "data.js"), dataBody);
  for (const [name, content] of entries) {
    const target = path.join(root, `${name}.js`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `window.__sq.register(${JSON.stringify(name)},${JSON.stringify(content)});`);
  }
  const manifestPaths = [...entries.map(([name]) => name), ...extraLogicalPaths];
  await fs.writeFile(path.join(root, "manifest.js"), `window.__sq.registerManifest(${JSON.stringify(manifestPaths)});`);
}

async function writePage(root: string, config: StaticQLConfig, bundlePath?: string): Promise<void> {
  if (bundlePath) await fs.copyFile(bundlePath, path.join(root, "page-entry.js"));
  const configAttribute = escapeAttribute(JSON.stringify(config));
  const html = `<!doctype html><html data-config="${configAttribute}"><head><meta charset="utf-8"><script src="./page-entry.js"></script></head><body><main>file protocol prototype</main></body></html>`;
  await fs.writeFile(path.join(root, "page.html"), html);
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function recursiveFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await recursiveFiles(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result.sort();
}

async function countFiles(root: string): Promise<number> {
  return (await recursiveFiles(root)).length;
}

async function runObservations(dataset: Dataset, children: Set<ChildProcess>, profiles: Set<string>) {
  const browser = await launchBrowser(dataset.root, children, profiles);
  try {
    const pageState = await evaluate(browser.cdp, `({sq:typeof window.__sq, href:location.href, readyState:document.readyState, scripts:Array.from(document.scripts).map(s=>s.src), errors:window.__fileProtocolErrors, resources:performance.getEntriesByType('resource').map(e=>e.name), html:document.documentElement.outerHTML.slice(0,500)})`);
    if (pageState.sq !== "object") {
      const bundle = await fs.readFile(path.join(dataset.root, "page-entry.js"), "utf8");
      throw new Error(`page-entry failed to initialize: ${JSON.stringify({ pageState, bundleStart: bundle.slice(0, 250) })}`);
    }
    const c1 = await evaluate(browser.cdp, `(() => new Promise((resolve) => {
      const outcomes = {};
      const run = (name, src) => new Promise((done) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => done({ event: 'load' });
        script.onerror = () => done({ event: 'error' });
        document.head.appendChild(script);
      }).then((value) => outcomes[name] = value);
      const errors = [];
      const listener = (event) => errors.push({ message: event.message, filename: event.filename });
      window.addEventListener('error', listener);
      run('present', './probe.js').then(() => run('missing', './absent-probe.js'))
        .then(() => run('syntax', './broken.txt.js')).then(() => {
          window.removeEventListener('error', listener);
          resolve({ outcomes, syntaxWindowErrors: errors, presentExecuted: window.__sqProbeLoaded === true });
        });
    }))()`);
    const expected = await expectedScenarios(dataset);
    const c2: Record<string, unknown> = {};
    const c3: Record<string, unknown> = {};
    for (const absence of ["strict", "lenient", "manifest"] as const) {
      const browserResult = await evaluate(browser.cdp, `window.__sq.run(${JSON.stringify(dataset.inputs)},${JSON.stringify(absence)})`);
      const actual = browserResult.result as Record<string, unknown>;
      const comparisons: Record<string, unknown> = {};
      for (const key of Object.keys(expected)) {
        const expectedValue = canonical(expected[key as keyof typeof expected]);
        const actualEnvelope = actual[key] as { status?: string; value?: unknown; name?: string; message?: string };
        const actualValue = actualEnvelope.status === "resolved" ? canonical(actualEnvelope.value) : undefined;
        comparisons[key] = {
          matches: actualEnvelope.status === "resolved" && JSON.stringify(expectedValue) === JSON.stringify(actualValue),
          expectedRecords: recordCount(expectedValue),
          actualStatus: actualEnvelope.status,
          actualRecords: actualEnvelope.status === "resolved" ? recordCount(actualEnvelope.value) : undefined,
          ...(actualEnvelope.status === "rejected" ? { actualError: { name: actualEnvelope.name, message: actualEnvelope.message } } : {}),
        };
      }
      c2[absence] = comparisons;
      c3[absence] = await evaluate(browser.cdp, `window.__sq.observeErrors(${JSON.stringify(absence)})`);
    }
    return { C1: c1, C2: c2, C3: c3 };
  } finally {
    browser.cdp.close();
  }
}

async function runMeasurements(datasets: Dataset[], children: Set<ChildProcess>, profiles: Set<string>) {
  const rows: Array<Record<string, unknown>> = [];
  for (const dataset of datasets) {
    const expected = await expectedScenarios(dataset);
    const modes = [
      { mode: "A", absence: "strict" },
      { mode: "B", absence: "strict" },
      { mode: "B", absence: "manifest" },
    ] as const;
    for (const { mode, absence } of modes) {
      const perQuery = new Map<string, Array<{ elapsedMs: number; fileCount: number; bytes: number; matches: boolean }>>();
      for (const query of ["Q-index", "Q-relation"] as const) perQuery.set(query, []);
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const browser = await launchBrowser(dataset.root, children, profiles);
        try {
          await browser.cdp.send("Network.enable");
          await browser.cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
          for (const [queryIndex, query] of (["Q-index", "Q-relation"] as const).entries()) {
            if (queryIndex > 0) await reloadPage(browser.cdp, dataset.root);
            const value = await evaluate(browser.cdp, `window.__sq.runC4(${JSON.stringify(mode)},${JSON.stringify(query)},${JSON.stringify(dataset.inputs)},${JSON.stringify(absence)})`) as {
              result: unknown;
              error?: { name: string; message: string };
              elapsedMs: number;
            stats: { scriptUrls: string[]; paths: string[]; bytes: number };
            };
            const byteCount = await byteSizeForUrls(value.stats.scriptUrls);
            const expectedValue = query === "Q-index"
              ? await executeC4Query(defineStaticQL(dataset.config)({ repository: new FsRepository(dataset.root) }), query, dataset.inputs)
              : await executeC4Query(defineStaticQL(dataset.config)({ repository: new FsRepository(dataset.root) }), query, dataset.inputs);
            const measurements = perQuery.get(query)!;
            measurements.push({
              elapsedMs: value.elapsedMs,
              fileCount: value.stats.scriptUrls.length,
              bytes: byteCount,
              logicalFileCount: value.stats.paths.length,
              logicalContentBytes: value.stats.bytes,
              matches: !value.error && JSON.stringify(canonical(value.result)) === JSON.stringify(canonical(expectedValue)),
              ...(value.error ? { error: value.error } : {}),
            });
          }
        } finally {
          browser.cdp.close();
        }
      }
      for (const [query, measurements] of perQuery) {
        const elapsed = measurements.map((item) => item.elapsedMs).sort((a, b) => a - b);
        rows.push({
          dataset: dataset.name,
          mode,
          ...(mode === "B" ? { absence } : {}),
          query,
          samples: measurements.length,
          scriptUrlCount: median(measurements.map((item) => item.fileCount)),
          scriptUrlRatioOfAllLogicalFiles: Number((median(measurements.map((item) => item.fileCount)) / dataset.logicalFileCount).toFixed(4)),
          generatedJsBytes: median(measurements.map((item) => item.bytes)),
          logicalFileCount: median(measurements.map((item) => item.logicalFileCount)),
          logicalContentBytes: median(measurements.map((item) => item.logicalContentBytes)),
          elapsedMsMedian: median(elapsed),
          elapsedMsMin: elapsed[0],
          elapsedMsMax: elapsed[elapsed.length - 1],
          fullLogicalFileCount: dataset.logicalFileCount,
          queryMatchesFsRepository: measurements.every((item) => item.matches),
          ...(measurements.some((item) => !item.matches) ? { differingSamples: measurements.filter((item) => !item.matches) } : {}),
        });
      }
    }
  }
  return rows;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function recordCount(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) return undefined;
  return value.data.length;
}

async function byteSizeForUrls(urls: string[]): Promise<number> {
  let total = 0;
  for (const url of urls) total += (await fs.stat(fileURLToPath(url))).size;
  return total;
}

async function launchBrowser(root: string, children: Set<ChildProcess>, profiles: Set<string>) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "staticql-chromium-profile-"));
  profiles.add(profile);
  const child = spawn(chromiumPath, [
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  children.add(child);
  let stderrBuffer = "";
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for Chromium DevTools URL")), 20000);
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      const match = stderrBuffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]!);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chromium exited before DevTools became ready (${code}): ${stderrBuffer}`));
    });
  });
  const browserEndpoint = new URL(wsUrl);
  const targetsResponse = await fetch(`http://${browserEndpoint.hostname}:${browserEndpoint.port}/json/list`);
  if (!targetsResponse.ok) throw new Error(`Chromium target listing failed: HTTP ${targetsResponse.status}`);
  const targets = await targetsResponse.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
  const pageTarget = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!pageTarget?.webSocketDebuggerUrl) throw new Error("Chromium did not expose a page target");
  const cdp = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__fileProtocolErrors = []; window.addEventListener('error', (event) => window.__fileProtocolErrors.push({message:event.message, filename:event.filename}));`,
  });
  const navigation = await cdp.send("Page.navigate", { url: pathToFileURL(path.join(root, "page.html")).href });
  await waitForLoad(cdp, String(navigation.result?.loaderId ?? ""));
  return { cdp, child, profile };
}

async function waitForLoad(cdp: CdpClient, loaderId: string): Promise<void> {
  const isTargetLoad = (message: CdpMessage) => message.params?.name === "load" && message.params?.loaderId === loaderId;
  if (isTargetLoad(cdp.latest("Page.lifecycleEvent") ?? {})) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(new Error("Timed out waiting for page load"));
    }, 20000);
    const stop = cdp.on("Page.lifecycleEvent", (message) => {
      if (!isTargetLoad(message)) return;
      clearTimeout(timeout);
      stop();
      resolve();
    });
  });
}

async function reloadPage(cdp: CdpClient, root: string): Promise<void> {
  const reloaded = await cdp.send("Page.navigate", { url: pathToFileURL(path.join(root, "page.html")).href });
  await waitForLoad(cdp, String(reloaded.result?.loaderId ?? ""));
}

async function evaluate(cdp: CdpClient, expression: string): Promise<any> {
  const response = await cdp.send("Runtime.evaluate", {
    expression: `(async () => JSON.stringify(await (${expression})))()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 120000,
  });
  const details = response.result?.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
  if (details) throw new Error(`Page evaluation failed: ${details.exception?.description ?? details.text ?? "unknown exception"}`);
  const remote = response.result?.result as { value?: unknown } | undefined;
  if (typeof remote?.value !== "string") throw new Error(`Page evaluation did not return JSON text: ${JSON.stringify(remote)}`);
  return JSON.parse(remote.value);
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000)),
  ]);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
