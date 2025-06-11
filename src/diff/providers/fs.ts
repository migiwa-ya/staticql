import type { DiffProvider, DiffLine } from "./index.js";

export class FsDiffProvider implements DiffProvider {
  constructor(private baseDir: string) {}

  async diffLines(baseRef: string, headRef: string): Promise<DiffLine[]> {
    throw new Error("FsDiffProvider is not implemented");
  }

  async gitShow(rev: string, filePath: string): Promise<string> {
    throw new Error("FsDiffProvider is not implemented");
  }
}