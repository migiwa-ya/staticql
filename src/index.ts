import { ContentDB } from "./ContentDB";
import type { ContentDBConfig } from "./types.ts";

export function defineContentDB(config: ContentDBConfig): ContentDB {
  return new ContentDB(config);
}
