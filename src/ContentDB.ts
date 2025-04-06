import { DataLoader } from "./DataLoader.js";
import { Indexer } from "./Indexer.js";
import type { ContentDBConfig } from "./types";
import { QueryBuilder } from "./QueryBuilder.js";

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
