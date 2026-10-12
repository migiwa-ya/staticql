import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BOOTSTRAP_LOAD_FAILURE_NOTE, generateDemo } from "./demo.js";
import { ScriptRepository } from "./src/ScriptRepository.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chromiumPath = "/usr/bin/chromium";
const scratchParent = path.join(repoRoot, ".cache");

async function main(): Promise<void> {
  assert.equal(new ScriptRepository("file:///x/", "B").absencePolicy, "lenient",
    "ScriptRepository should default to lenient absence handling");
  pass("ScriptRepository の既定 policy: lenient");
  await fs.access(chromiumPath);
  await fs.mkdir(scratchParent, { recursive: true });
  const scratchRoot = await fs.mkdtemp(path.join(scratchParent, "file-protocol-demo-check-"));
  let outsideRoot: string | undefined;
  try {
    outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "staticql-demo-check-outside-"));
    assert.ok(outsideRoot, "external symlink test directory should be created");
    const normalOutDir = path.join(scratchRoot, "normal");
    const generated = await generateDemo(normalOutDir);
    assert.equal(generated.logicalPaths.includes("index/herbs.name/30b4/_index.jsonl"), true,
      "30b4 index shard should be present in the generated fixture");
    assert.equal(await pathExists(path.join(normalOutDir, "manifest.js")), false,
      "default generation should omit manifest.js");
    const normalDom = await inspectPage(path.join(normalOutDir, "index.html"), true);
    assertSuccessfulDemo(normalDom, generated.expected.logicalFileCount, "normal output", "lenient");
    pass("通常出力: 3 クエリ一致、各クエリが一部ファイルのみ取得");

    const copiedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "staticql-file-protocol-copy-"));
    try {
      const copiedOutDir = path.join(copiedRoot, "demo");
      await fs.cp(normalOutDir, copiedOutDir, { recursive: true, errorOnExist: true });
      const copiedDom = await inspectPage(path.join(copiedOutDir, "index.html"), true);
      assertSuccessfulDemo(copiedDom, generated.expected.logicalFileCount, "copied output", "lenient");
      pass("別の場所へのコピー: file:// で同じ 3 クエリが一致");
    } finally {
      await fs.rm(copiedRoot, { recursive: true, force: true });
    }

    const missingShardDir = path.join(scratchRoot, "missing-shard");
    await fs.cp(normalOutDir, missingShardDir, { recursive: true, errorOnExist: true });
    const missingShardPath = path.join(missingShardDir, "index/herbs.name/30b4/_index.jsonl.js");
    assert.equal(await pathExists(missingShardPath), true, "C5 index shard deletion target should exist");
    await fs.rm(missingShardPath);
    const missingShardDom = await inspectPage(path.join(missingShardDir, "index.html"), true);
    assertLenientMissingShard(missingShardDom);
    pass("lenient で必要な index shard が欠落: 不一致、例外行なし、全体は成功にならない");

    const malformedDir = path.join(scratchRoot, "malformed-payload");
    await fs.cp(normalOutDir, malformedDir, { recursive: true, errorOnExist: true });
    const malformedLogicalPath = "content/herbs/arctium-lappa.md";
    assert.equal(generated.logicalPaths.includes(malformedLogicalPath), true, "C5 malformed payload target should exist");
    const malformedPayloadPath = path.join(malformedDir, `${malformedLogicalPath}.js`);
    assert.equal(await pathExists(malformedPayloadPath), true, "C5 malformed payload file should exist");
    await fs.writeFile(malformedPayloadPath, "this is not valid JavaScript !!!\n", "utf8");
    const malformedDom = await inspectPage(path.join(malformedDir, "index.html"), true);
    assertErrorKind(malformedDom, "other", "lenient 構文エラー payload");
    pass("lenient でも構文エラー payload はその他のエラーとして表示");

    const manifestOutDir = path.join(scratchRoot, "manifest");
    const manifestGenerated = await generateDemo(manifestOutDir, { manifest: true });
    assert.equal(await pathExists(path.join(manifestOutDir, "manifest.js")), true,
      "manifest option should generate manifest.js");
    const manifestDom = await inspectPage(path.join(manifestOutDir, "index.html"), true);
    assertSuccessfulDemo(manifestDom, manifestGenerated.expected.logicalFileCount, "manifest output", "manifest");
    pass("manifest オプション: manifest.js を生成し、3 クエリが一致");

    const manifestPayloadDir = path.join(scratchRoot, "manifest-missing-payload");
    await fs.cp(manifestOutDir, manifestPayloadDir, { recursive: true, errorOnExist: true });
    const manifestIndexPath = "index/herbs.name/_prefixes.jsonl.js";
    assert.equal(manifestGenerated.logicalPaths.includes(manifestIndexPath.slice(0, -3)), true,
      "manifest payload deletion target should be listed");
    const manifestPayloadPath = path.join(manifestPayloadDir, manifestIndexPath);
    assert.equal(await pathExists(manifestPayloadPath), true, "manifest payload deletion target should exist");
    await fs.rm(manifestPayloadPath);
    const missingManifestPayloadDom = await inspectPage(path.join(manifestPayloadDir, "index.html"), true);
    assertErrorKind(missingManifestPayloadDom, "other", "manifest 掲載 payload の欠落");
    assert.match(missingManifestPayloadDom, /file:\/\//, "failed payload URL should be shown");
    pass("manifest 掲載 payload の欠落: その他のエラーとして表示");

    const missingManifestDir = path.join(scratchRoot, "missing-manifest");
    await fs.cp(manifestOutDir, missingManifestDir, { recursive: true, errorOnExist: true });
    const manifestFilePath = path.join(missingManifestDir, "manifest.js");
    assert.equal(await pathExists(manifestFilePath), true, "manifest deletion target should exist");
    await fs.rm(manifestFilePath);
    const missingManifestDom = await inspectPage(path.join(missingManifestDir, "index.html"), true);
    assertErrorKind(missingManifestDom, "not-found", "manifest.js の欠落");
    pass("manifest.js の欠落: 不在として表示");

    await verifyCli(scratchRoot);
    pass("CLI: --manifest 両引数順、既定では manifest なし、未知フラグ拒否");

    const indexOnlyDir = await fs.mkdtemp(path.join(os.tmpdir(), "staticql-demo-index-only-"));
    try {
      await fs.copyFile(path.join(normalOutDir, "index.html"), path.join(indexOnlyDir, "index.html"));
      const indexOnlyDom = await inspectPage(path.join(indexOnlyDir, "index.html"), false);
      assertBootstrapLoadError(indexOnlyDom, "demo-entry.js");
      pass("index.html 単体コピー: demo-entry.js のエラーを赤字表示");
    } finally {
      await fs.rm(indexOnlyDir, { recursive: true, force: true });
    }

    await fs.cp(normalOutDir, path.join(scratchRoot, "expected-case-copy"), { recursive: true });
    const expectedCaseDir = path.join(scratchRoot, "expected-case-copy");
    await fs.rm(path.join(expectedCaseDir, "expected.js"));
    const missingExpectedDom = await inspectPage(path.join(expectedCaseDir, "index.html"), true);
    assertBootstrapLoadError(missingExpectedDom, "expected.js");
    pass("expected.js の欠落: エラーを赤字表示");

    await verifyNonEmptyOutputIsPreserved(scratchRoot);
    pass("非空 outDir: 失敗終了し既存ファイルを保持");

    await verifySymlinkEscapeIsRejected(scratchRoot, outsideRoot);
    pass("リポジトリ外を指す symlink outDir: 書き込み前に拒否");

    console.log("demo-check: すべての確認に合格しました。");
  } finally {
    await fs.rm(scratchRoot, { recursive: true, force: true });
    if (outsideRoot) await fs.rm(outsideRoot, { recursive: true, force: true });
  }
}

async function verifyCli(scratchRoot: string): Promise<void> {
  const demoPath = path.join(repoRoot, "experiments/file-protocol/demo.ts");
  const positionalFirst = path.join(scratchRoot, "cli-positional-first");
  const flagFirst = path.join(scratchRoot, "cli-flag-first");
  const defaultMode = path.join(scratchRoot, "cli-default");
  const unknownFlag = path.join(scratchRoot, "cli-unknown-flag");

  const positionalResult = await runDemoCli([demoPath, positionalFirst, "--manifest"]);
  assert.equal(positionalResult.code, 0, `CLI positional-first failed: ${positionalResult.stderr}`);
  assert.equal(await pathExists(path.join(positionalFirst, "manifest.js")), true,
    "CLI positional-first should generate manifest.js");

  const flagResult = await runDemoCli([demoPath, "--manifest", flagFirst]);
  assert.equal(flagResult.code, 0, `CLI flag-first failed: ${flagResult.stderr}`);
  assert.equal(await pathExists(path.join(flagFirst, "manifest.js")), true,
    "CLI flag-first should generate manifest.js");

  const defaultResult = await runDemoCli([demoPath, defaultMode]);
  assert.equal(defaultResult.code, 0, `CLI default mode failed: ${defaultResult.stderr}`);
  assert.equal(await pathExists(path.join(defaultMode, "manifest.js")), false,
    "CLI without --manifest should not generate manifest.js");

  const invalidResult = await runDemoCli([demoPath, unknownFlag, "--unknown"]);
  assert.notEqual(invalidResult.code, 0, "CLI unknown flag should exit non-zero");
  assert.match(invalidResult.stderr, /使用方法:/, "CLI unknown flag should print usage");
  assert.equal(await pathExists(unknownFlag), false, "CLI unknown flag should not create output");
}

async function runDemoCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn("npx", ["--no-install", "tsx", ...args], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, npm_config_offline: "true" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function verifyNonEmptyOutputIsPreserved(scratchRoot: string): Promise<void> {
  const outDir = path.join(scratchRoot, "occupied");
  await fs.mkdir(outDir);
  const sentinelPath = path.join(outDir, "keep.txt");
  await fs.writeFile(sentinelPath, "existing user data\n", "utf8");
  await assert.rejects(generateDemo(outDir), /空ではありません/);
  assert.equal(await fs.readFile(sentinelPath, "utf8"), "existing user data\n");
  assert.deepEqual(await fs.readdir(outDir), ["keep.txt"]);
}

async function verifySymlinkEscapeIsRejected(scratchRoot: string, outsideRoot: string): Promise<void> {
  const linkPath = path.join(scratchRoot, "external-output");
  const sentinelPath = path.join(outsideRoot, "keep.txt");
  await fs.writeFile(sentinelPath, "outside data\n", "utf8");
  await fs.symlink(outsideRoot, linkPath, "dir");
  await assert.rejects(generateDemo(linkPath), /リポジトリ外|シンボリックリンク/);
  assert.deepEqual((await fs.readdir(outsideRoot)).sort(), ["keep.txt"]);
  assert.equal(await fs.readFile(sentinelPath, "utf8"), "outside data\n");
}

function assertSuccessfulDemo(
  dom: string,
  logicalFileCount: number,
  description: string,
  policy: "lenient" | "manifest",
): void {
  assert.match(dom, /id="status"[^>]*data-status="complete"/, `${description}: all rows should complete`);
  const policyElement = dom.match(/<p id="absence-policy"[^>]*>([\s\S]*?)<\/p>/);
  assert.ok(policyElement, `${description}: absence policy should be displayed`);
  assert.equal(attribute(policyElement[0], "data-policy"), policy,
    `${description}: policy data attribute should identify ${policy}`);
  assert.equal(policyElement[1], `不在判定: ${policy}`,
    `${description}: visible policy should identify ${policy}`);
  const warning = dom.match(/<p id="absence-warning">([\s\S]*?)<\/p>/)?.[1] ?? "";
  assert.equal(warning.includes("読み込めなかったファイルは不在とみなされる"), policy === "lenient",
    `${description}: lenient warning visibility should match the active policy`);
  const resultsBody = dom.match(/<tbody id="results">([\s\S]*?)<\/tbody>/)?.[1];
  assert.ok(resultsBody, `${description}: results table body should exist`);
  const rows = resultsBody.match(/<tr\b[^>]*>/g) ?? [];
  assert.equal(rows.length, 3, `${description}: should render exactly three query rows`);
  for (const [index, row] of rows.entries()) {
    assert.equal(attribute(row, "data-match"), "true", `${description}: query row ${index + 1} should match FsRepository`);
    const fileCount = Number(attribute(row, "data-files"));
    assert.ok(Number.isInteger(fileCount) && fileCount > 0, `${description}: query row ${index + 1} should load files`);
    assert.ok(fileCount < logicalFileCount, `${description}: query row ${index + 1} should not load every logical file`);
  }
}

function assertLenientMissingShard(dom: string): void {
  assert.match(dom, /id="status"[^>]*data-status="error"/,
    "missing required shard should prevent the overall run from completing successfully");
  const resultsBody = dom.match(/<tbody id="results">([\s\S]*?)<\/tbody>/)?.[1];
  assert.ok(resultsBody, "missing shard: results table body should exist");
  const rows = resultsBody.match(/<tr\b[^>]*>/g) ?? [];
  assert.equal(rows.length, 3, "missing shard should still render all three query rows");
  assert.equal(attribute(rows[0], "data-match"), "false", "first query should not match after its shard is removed");
  assert.equal(attribute(rows[0], "data-status"), "failed", "missing shard should render a failed result row");
  assert.equal(rows.some((row) => attribute(row, "data-error-kind") !== undefined), false,
    "lenient shard absence should not render an exception row");
}

function assertBootstrapLoadError(dom: string, fileName: "expected.js" | "demo-entry.js"): void {
  const displayedMessage = dom.match(/<p id="boot-error" class="error" role="alert">([\s\S]*?)<\/p>/)?.[1] ?? "";
  assert.equal(
    displayedMessage,
    `${fileName} が読めない (${BOOTSTRAP_LOAD_FAILURE_NOTE})`,
    `${fileName}: #boot-error should show the filename and complete file:// limitation note`,
  );
}

function assertErrorKind(dom: string, kind: "not-found" | "other", description: string): void {
  const rows = dom.match(/<tr\b[^>]*>/g) ?? [];
  const failed = rows.find((row) => attribute(row, "data-error-kind") === kind);
  assert.ok(failed, `${description}: a row should expose data-error-kind=${kind}`);
  assert.match(dom, kind === "not-found" ? /不在:/ : /その他:/, `${description}: visible error kind should be rendered`);
  assert.match(dom, /data-status="error"/, `${description}: page should expose an error status`);
}

function attribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return tag.match(new RegExp(`\\b${escaped}="([^"]*)"`))?.[1];
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
  private readonly pending = new Map<number, { resolve(message: CdpMessage): void; reject(error: Error): void }>();
  private readonly listeners = new Map<string, Array<(message: CdpMessage) => void>>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? "CDP command failed"));
        else pending.resolve(message);
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message);
      }
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Chromium CDP connection closed"));
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

  on(method: string, listener: (message: CdpMessage) => void): () => void {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
    return () => this.listeners.set(method, listeners.filter((candidate) => candidate !== listener));
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

async function inspectPage(indexPath: string, autorun: boolean): Promise<string> {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "staticql-demo-chromium-"));
  let child: ChildProcess | undefined;
  let cdp: CdpClient | undefined;
  let stderr = "";
  try {
    const url = pathToFileURL(indexPath);
    if (autorun) url.hash = "autorun";
    child = spawn(chromiumPath, [
      "--headless",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
    ], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const debuggerUrl = await waitForDevTools(child, () => stderr);
    const endpoint = new URL(debuggerUrl);
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/list`);
    assert.equal(response.ok, true, `Chromium target list failed: HTTP ${response.status}`);
    const targets = await response.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
    const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    assert.ok(target?.webSocketDebuggerUrl, "Chromium did not expose a page target");

    cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
    await cdp.send("Runtime.enable");
    let loaderId = "";
    const loaded = waitForCdpEvent(cdp, "Page.lifecycleEvent", (message) =>
      message.params?.name === "load" && message.params?.loaderId === loaderId);
    const navigation = await cdp.send("Page.navigate", { url: url.href });
    loaderId = String(navigation.result?.loaderId ?? "");
    assert.ok(loaderId, "Chromium did not return the navigation loader id");
    await loaded;

    if (autorun) {
      const completion = await evaluate(cdp, `new Promise((resolve, reject) => {
        const status = document.getElementById('status');
        if (!status) { reject(new Error('demo status element is missing')); return; }
        const finished = () => status.dataset.status === 'complete' || status.dataset.status === 'error';
        if (finished()) { resolve(true); return; }
        const observer = new MutationObserver(() => {
          if (!finished()) return;
          clearTimeout(timer);
          observer.disconnect();
          resolve(true);
        });
        observer.observe(status, { attributes: true, childList: true, characterData: true, subtree: true });
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error('demo queries did not complete within 20 seconds; status=' + status.outerHTML + '; rows=' + document.getElementById('results')?.innerHTML));
        }, 20000);
      })`);
      assert.equal(completion, true, "demo queries should reach a terminal state");
    }

    const dom = await evaluate(cdp, "document.documentElement.outerHTML");
    assert.ok(typeof dom === "string" && dom.includes("<html"), "Chromium did not return the page DOM");
    return dom;
  } finally {
    cdp?.close();
    if (child?.pid) {
      signalProcessGroup(child.pid, "SIGTERM");
      await waitForExit(child, 2000);
      signalProcessGroup(child.pid, "SIGKILL");
      await waitForExit(child, 2000);
    }
    await fs.rm(profile, { recursive: true, force: true });
  }
}

function signalProcessGroup(processId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
}

async function waitForDevTools(child: ChildProcess, currentStderr: () => string): Promise<string> {
  const stream = child.stderr;
  assert.ok(stream, "Chromium stderr was not captured");
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for Chromium DevTools: ${currentStderr()}`)), 20000);
    const onData = (chunk: Buffer) => {
      const match = `${currentStderr()}${chunk.toString()}`.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) finish(undefined, match[1]);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(new Error(`Chromium exited before DevTools was ready (${code}): ${currentStderr()}`));
    const finish = (error?: Error, url?: string) => {
      clearTimeout(timeout);
      stream.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(url!);
    };
    stream.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForCdpEvent(
  cdp: CdpClient,
  method: string,
  predicate: (message: CdpMessage) => boolean,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for Chromium ${method}`)), 20000);
    const stop = cdp.on(method, (message) => {
      if (predicate(message)) finish();
    });
    function finish(error?: Error): void {
      clearTimeout(timeout);
      stop();
      if (error) reject(error);
      else resolve();
    }
  });
}

async function evaluate(cdp: CdpClient, expression: string): Promise<unknown> {
  const response = await cdp.send("Runtime.evaluate", {
    expression: `(async () => await (${expression}))()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 25000,
  });
  const details = response.result?.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
  if (details) throw new Error(`Page evaluation failed: ${details.exception?.description ?? details.text ?? "unknown exception"}`);
  return (response.result?.result as { value?: unknown } | undefined)?.value;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, timeoutMs);
    child.once("exit", done);
    function done(): void {
      clearTimeout(timeout);
      child.off("exit", done);
      resolve();
    }
  });
}

function pass(message: string): void {
  console.log(`PASS ${message}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
