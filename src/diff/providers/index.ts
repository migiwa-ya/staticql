export interface DiffProvider {
  diffLines(baseRef: string, headRef: string): Promise<string[]>;
  gitShow(rev: string, filePath: string): Promise<string>;
}

export { GitDiffProvider } from "./git.js";
export type { GitHubDiffProviderOptions } from "./github.js";
export { GitHubDiffProvider } from "./github.js";
export { FsDiffProvider } from "./fs.js";