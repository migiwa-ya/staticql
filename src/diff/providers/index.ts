/** A single diff line with status and file path. */
export type DiffLine = {
  /** 'A' = added, 'D' = removed, 'M' = modified */
  status: 'A' | 'D' | 'M';
  /** File path affected by the diff */
  path: string;
};

export interface DiffProvider {
  /**
   * List diff entries between two refs.
   * @param baseRef base revision or ref
   * @param headRef head revision or ref
   * @returns array of DiffLine objects
   */
  diffLines(baseRef: string, headRef: string): Promise<DiffLine[]>;
  /**
   * Show file content at a specific revision.
   * @param rev revision or ref
   * @param filePath path to file
   * @returns file content as text
   */
  gitShow(rev: string, filePath: string): Promise<string>;
}

export { GitDiffProvider } from "./git.js";
export type { GitHubDiffProviderOptions } from "./github.js";
export { GitHubDiffProvider } from "./github.js";
export { FsDiffProvider } from "./fs.js";