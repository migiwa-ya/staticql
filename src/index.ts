import { ContentDB } from "./ContentDB.js";
import type { ContentDBConfig } from "./types";

export function defineContentDB(config: ContentDBConfig): ContentDB {
  return new ContentDB(config);
}
