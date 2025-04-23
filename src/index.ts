import { ContentDB } from "./ContentDB.js";
import type { ContentDBConfig } from "./types";
import { FileSystemProvider } from "./storage/FileSystemProvider.js";
import { S3Provider } from "./storage/S3Provider.js";
import type { StorageProvider } from "./storage/StorageProvider.js";

export function defineContentDB(config: ContentDBConfig): ContentDB {
  let provider: StorageProvider;
  if (config.storage?.type === "s3") {
    provider = new S3Provider(config.storage);
  } else {
    provider = new FileSystemProvider(config.storage?.baseDir);
  }
  return new ContentDB(config, provider);
}
