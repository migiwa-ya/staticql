import { DataLoader } from "./DataLoader.js";
import { Indexer } from "./Indexer.js";
import type { ContentDBConfig, SourceRecord } from "./types";
import { QueryBuilder } from "./QueryBuilder.js";
import type { StorageProvider } from "./storage/StorageProvider";

export class ContentDB {
  private config: ContentDBConfig;
  private loader: DataLoader<SourceRecord>;
  private indexer: Indexer<SourceRecord>;

  constructor(config: ContentDBConfig, provider: StorageProvider) {
    this.config = config;
    this.loader = new DataLoader<SourceRecord>(config, provider);
    this.indexer = new Indexer<SourceRecord>(this.loader, config);
  }

  /**
   * 指定sourceの型安全なQueryBuilderを生成する
   * @param source - source名
   * @returns QueryBuilder<T>
   */
  from<T extends SourceRecord>(source: string): QueryBuilder<T> {
    const loader = new DataLoader<T>(
      this.config,
      (this.loader as any).provider
    );

    return new QueryBuilder<T>(source, this.config, loader, []);
  }

  /**
   * 全sourceのインデックス/メタファイルを config.storage.output ディレクトリに出力する
   * @returns Promise<void>
   * @throws ストレージ書き込み失敗時に例外
   */
  async saveIndexes() {
    const output = this.config.storage.output;

    return this.indexer.saveTo(output);
  }
}
