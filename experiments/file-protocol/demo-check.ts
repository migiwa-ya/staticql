import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BOOTSTRAP_LOAD_FAILURE_NOTE, generateDemo } from "./demo.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const chromiumPath = "/usr/bin/chromium";
const scratchParent = path.join(repoRoot, ".cache");

async function main(): Promise<void> {
  await fs.access(chromiumPath);
  await fs.mkdir(scratchParent, { recursive: true });
  const scratchRoot = await fs.mkdtemp(path.join(scratchParent, "file-protocol-demo-check-"));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "staticql-demo-check-outside-"));
  try {
    const normalOutDir = path.join(scratchRoot, "normal");
    const generated = await generateDemo(normalOutDir);
    const normalDom = await inspectPage(path.join(normalOutDir, "index.html"), true);
    assertSuccessfulDemo(normalDom, generated.expected.logicalFileCount, "normal output");
    pass("通常出力: 3 クエリ一致、各クエリが一部ファイルのみ取得");

    const copiedOutDir = path.join(os.tmpdir(), `staticql-file-protocol-copy-${process.pid}-${Date.now()}`);
    try {
      await fs.cp(normalOutDir, copiedOutDir, { recursive: true, errorOnExist: true });
      const copiedDom = await inspectPage(path.join(copiedOutDir, "index.html"), true);
      assertSuccessfulDemo(copiedDom, generated.expected.logicalFileCount, "copied output");
      pass("別の場所へのコピー: file:// で同じ 3 クエリが一致");
    } finally {
      await fs.rm(copiedOutDir, { recursive: true, force: true });
    }

    const indexLogicalPath = generated.logicalPaths.find((item) => item === "index/herbs.name/_prefixes.jsonl");
    assert.ok(indexLogicalPath, "herbs.name クエリが使用する manifest 掲載 index ファイルが必要です");
    const missingIndexPayload = path.join(normalOutDir, `${indexLogicalPath}.js`);
    await fs.rm(missingIndexPayload);
    const missingIndexDom = await inspectPage(path.join(normalOutDir, "index.html"), true);
    assertErrorKind(missingIndexDom, "other", "manifest に掲載された index payload の欠落");
    assert.match(missingIndexDom, /file:\/\//, "失敗した payload URL が画面に表示されること");
    pass("manifest 掲載 payload の欠落: その他のエラーとして表示");

    await fs.rm(path.join(normalOutDir, "manifest.js"));
    const missingManifestDom = await inspectPage(path.join(normalOutDir, "index.html"), true);
    assertErrorKind(missingManifestDom, "not-found", "manifest.js の欠落");
    pass("manifest.js の欠落: 不在として表示");

    const indexOnlyDir = await fs.mkdtemp(path.join(os.tmpdir(), "staticql-demo-index-only-"));
    try {
      await fs.copyFile(path.join(normalOutDir, "index.html"), path.join(indexOnlyDir, "index.html"));
      const indexOnlyDom = await inspectPage(path.join(indexOnlyDir, "index.html"), false);
      assertBootstrapLoadError(indexOnlyDom, "demo-entry.js");
      pass("index.html 単体コピー: demo-entry.js のエラーを赤字表示");
    } finally {
      await fs.rm(indexOnlyDir, { recursive: true, force: true });
    }

    await fs.cp(await generateDemo(path.join(scratchRoot, "expected-case")).then((value) => value.outDir),
      path.join(scratchRoot, "expected-case-copy"), { recursive: true });
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
    await fs.rm(outsideRoot, { recursive: true, force: true });
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

function assertSuccessfulDemo(dom: string, logicalFileCount: number, description: string): void {
  assert.match(dom, /id="status"[^>]*data-status="complete"/, `${description}: all rows should complete`);
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
    ], { stdio: ["ignore", "ignore", "pipe"] });
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
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 2000);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child, 2000);
      }
    }
    await fs.rm(profile, { recursive: true, force: true });
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
