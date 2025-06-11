import type { DiffProvider, DiffLine } from "./index.js";

export interface GitHubDiffProviderOptions {
  owner: string;
  repo: string;
  token?: string;
}

export class GitHubDiffProvider implements DiffProvider {
  private owner: string;
  private repo: string;
  private token?: string;

  constructor(options: GitHubDiffProviderOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token;
  }

  private get headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
    };
    if (this.token) {
      headers.Authorization = `token ${this.token}`;
    }
    return headers;
  }

  async diffLines(baseRef: string, headRef: string): Promise<DiffLine[]> {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/compare/${baseRef}...${headRef}`;
    const res = await fetch(url, { headers: this.headers });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(
        `GitHub API error fetching diff compare: ${(data && data.message) || res.status}`,
      );
    }
    if (!Array.isArray(data.files)) {
      return [];
    }
    const statusMap: Record<string, DiffLine['status']> = {
      added: "A",
      removed: "D",
      modified: "M",
    };
    return data.files
      .filter((file: any) => ["added", "removed", "modified"].includes(file.status))
      .map((file: any) => ({
        status: statusMap[file.status],
        path: file.filename,
      }));
  }

  async gitShow(rev: string, filePath: string): Promise<string> {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${filePath}?ref=${rev}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3.raw",
    };
    if (this.token) {
      headers.Authorization = `token ${this.token}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(
        `GitHub API error fetching file ${filePath}@${rev}: ${res.status}`,
      );
    }
    return await res.text();
  }
}