import { DataLoader } from "./DataLoader";
import { Indexer } from "./Indexer";
import type { ContentDBConfig } from "./types.ts";
import { QueryBuilder } from "./QueryBuilder";

export class ContentDB {
  private config: ContentDBConfig;
  private loader: DataLoader;
  private indexer: Indexer;

  constructor(config: ContentDBConfig) {
    this.config = config;
    this.loader = new DataLoader(config);
    this.indexer = new Indexer(this.loader, config);
  }

  from(source: string) {
    return new QueryBuilder(source, this.config, this.loader, [], this.indexer);
  }

  async index() {
    return this.indexer.buildAll();
  }

  async saveIndexesTo(outputDir: string) {
    return this.indexer.saveTo(outputDir);
  }
}
