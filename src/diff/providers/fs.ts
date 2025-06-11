import type { DiffProvider } from "./index.js";

export class FsDiffProvider implements DiffProvider {
  constructor(private baseDir: string) {}

  async diffLines(): Promise<string[]> {
    throw new Error("FsDiffProvider is not implemented");
  }

  async gitShow(): Promise<string> {
    throw new Error("FsDiffProvider is not implemented");
  }
}