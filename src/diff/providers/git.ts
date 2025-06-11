import { execSync } from "child_process";

import type { DiffProvider, DiffLine } from "./index.js";

export class GitDiffProvider implements DiffProvider {
  constructor(private baseDir: string) {}

  async diffLines(baseRef: string, headRef: string): Promise<DiffLine[]> {
    const output = execSync(
      `git fetch origin main && git diff --name-status --diff-filter=ADM --no-renames ${baseRef}..${headRef}`,
      { encoding: "utf8", cwd: this.baseDir }
    );
    return output
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split(/\t/);
        return { status: status as DiffLine['status'], path };
      });
  }

  async gitShow(rev: string, filePath: string): Promise<string> {
    return execSync(`git show ${rev}:${filePath}`, {
      encoding: "utf8",
      cwd: this.baseDir,
    });
  }
}