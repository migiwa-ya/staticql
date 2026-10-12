import { defineStaticQL, type StaticQLConfig } from "../../../src/index.js";
import type { StaticQL } from "../../../src/StaticQL.js";
import { NotFoundError } from "../../../src/repository/errors.js";
import type { SourceRecord } from "../../../src/types.js";
import { ScriptRepository, type AbsencePolicy } from "./ScriptRepository.js";
import type { DemoExpected, QueryInputs } from "../demo.js";

declare global {
  interface Window {
    __sqExpected?: DemoExpected;
    __sq: {
      register(path: string, content: string): void;
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
};

const environment = requireElement("environment");
environment.textContent = `${navigator.userAgent} — protocol: ${location.protocol}`;
const absenceDisplay = requireElement("absence-policy");
const absenceWarning = requireElement("absence-warning");

const runButton = requireElement<HTMLButtonElement>("run");
runButton.addEventListener("click", () => void runQueries().catch(showFatalError));

interface QueryCase {
  key: keyof DemoExpected["results"];
  label: string;
  execute(staticql: StaticQL, inputs: QueryInputs): Promise<unknown>;
}

const queries: QueryCase[] = [
  {
    key: "herbs-name",
    label: "herbs: name eq",
    execute: (staticql, inputs) => staticql.from<SourceRecord, string>("herbs").where("name", "eq", inputs.name).exec(),
  },
  {
    key: "herbs-nameUpper",
    label: "herbs: customIndex nameUpper eq",
    execute: (staticql, inputs) => staticql.from<SourceRecord, string>("herbs").where("nameUpper", "eq", inputs.nameUpper).exec(),
  },
  {
    key: "recipes-herbs",
    label: "recipes join herbs: herbs.slug in",
    execute: (staticql, inputs) => staticql.from<SourceRecord, string>("recipes").join("herbs")
      .where("herbs.slug", "in", [inputs.herbSlug]).exec(),
  },
];

if (location.hash === "#autorun") {
  void runQueries().catch(showFatalError);
}

async function runQueries(): Promise<void> {
  const status = requireElement("status");
  const results = requireElement<HTMLTableSectionElement>("results");
  const bootError = requireElement("boot-error");
  results.replaceChildren();
  status.dataset.status = "running";
  status.textContent = "クエリを実行しています…";

  const absenceValue = document.documentElement.dataset.absence;
  if (absenceValue !== "lenient" && absenceValue !== "manifest") {
    throw new Error(`不在判定方式が不正です: ${absenceValue ?? "未指定"}`);
  }
  const absence = absenceValue as AbsencePolicy;

  if (!window.__sqExpected) {
    status.dataset.status = "error";
    status.textContent = "期待値ファイルを読み込めませんでした。";
    bootError.textContent ||= "expected.js が読めない";
    return;
  }

  bootError.textContent = "";
  let allMatched = true;
  for (const query of queries) {
    status.textContent = `${query.label} を実行しています…`;
    const repository = new ScriptRepository(new URL("./", location.href).href, "B", absence);
    activeRepository = repository;
    if (query === queries[0]) {
      absenceDisplay.dataset.policy = repository.absencePolicy;
      absenceDisplay.textContent = `不在判定: ${repository.absencePolicy}`;
      absenceWarning.textContent = repository.absencePolicy === "lenient"
        ? "読み込めなかったファイルは不在とみなされるため、実在するのに読めない場合も結果が欠落することがあります"
        : "";
    }
    const staticql = defineStaticQL(config)({ repository });
    try {
      const result = await query.execute(staticql, window.__sqExpected.inputs);
      const expectedResult = window.__sqExpected.results[query.key];
      const matches = JSON.stringify(canonical(result)) === JSON.stringify(canonical(expectedResult));
      allMatched &&= matches;
      appendRow(results, query.label, result, matches, repository.stats().scriptUrls, repository.stats().paths.length);
    } catch (error) {
      allMatched = false;
      const stats = repository.stats();
      appendErrorRow(results, query.label, error, stats.scriptUrls, stats.paths.length);
    } finally {
      activeRepository = undefined;
    }
  }

  status.dataset.status = allMatched ? "complete" : "error";
  status.textContent = allMatched ? "完了: すべての結果が FsRepository と一致しました。" : "完了: 一致しない結果またはエラーがあります。";
}

function appendRow(
  parent: HTMLTableSectionElement,
  label: string,
  result: unknown,
  matches: boolean,
  scriptUrls: string[],
  logicalFilesRead: number,
): void {
  const row = document.createElement("tr");
  row.dataset.match = String(matches);
  row.dataset.files = String(scriptUrls.length);
  row.dataset.status = matches ? "passed" : "failed";

  const records = getRecords(result);
  appendCell(row, label);
  appendPreCell(row, records.map((record) => record.slug ?? "(slug なし)"));

  const matchCell = document.createElement("td");
  matchCell.textContent = matches ? "一致" : "不一致";
  row.append(matchCell);

  appendFileCell(row, scriptUrls, logicalFilesRead);
  parent.append(row);
}

function appendErrorRow(
  parent: HTMLTableSectionElement,
  label: string,
  error: unknown,
  scriptUrls: string[],
  logicalFilesRead: number,
): void {
  const row = document.createElement("tr");
  const kind = error instanceof NotFoundError ? "not-found" : "other";
  row.dataset.match = "false";
  row.dataset.files = String(scriptUrls.length);
  row.dataset.errorKind = kind;
  row.dataset.status = "error";

  appendCell(row, label);
  const errorCell = document.createElement("td");
  errorCell.colSpan = 2;
  errorCell.className = "error";
  errorCell.textContent = `${kind === "not-found" ? "不在" : "その他"}: ${errorText(error)}`;
  row.append(errorCell);
  appendFileCell(row, scriptUrls, logicalFilesRead);
  parent.append(row);
}

function appendCell(row: HTMLTableRowElement, text: string): void {
  const cell = document.createElement("td");
  cell.textContent = text;
  row.append(cell);
}

function appendPreCell(row: HTMLTableRowElement, value: unknown): void {
  const cell = document.createElement("td");
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(value, null, 2);
  cell.append(pre);
  row.append(cell);
}

function appendFileCell(row: HTMLTableRowElement, scriptUrls: string[], logicalFilesRead: number): void {
  const cell = document.createElement("td");
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `${scriptUrls.length} 件の script（論理ファイル ${logicalFilesRead} 件）`;
  details.append(summary);
  const list = document.createElement("ul");
  const basePath = new URL("./", location.href).pathname;
  for (const url of scriptUrls) {
    const item = document.createElement("li");
    const pathname = new URL(url).pathname;
    item.textContent = pathname.startsWith(basePath) ? decodeURIComponent(pathname.slice(basePath.length)) : url;
    list.append(item);
  }
  details.append(list);
  cell.append(details);
  row.append(cell);
}

function getRecords(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) return [];
  return value.data.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const causeMessage = cause instanceof Error
    ? cause.message
    : cause && typeof cause === "object" && "message" in cause
      ? String(cause.message)
      : undefined;
  return [error.name, error.message, causeMessage].filter(Boolean).join(": ");
}

function showFatalError(error: unknown): void {
  const status = requireElement("status");
  status.dataset.status = "error";
  status.textContent = "デモの実行を完了できませんでした。";
  requireElement("boot-error").textContent = errorText(error);
}

function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`デモ画面に必要な要素がありません: #${id}`);
  return element as T;
}
