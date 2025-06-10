import { StorageRepository } from "./StorageRepository.js";
import { SourceConfigResolver } from "../SourceConfigResolver.js";

/**
 * MultiRepository: Wraps multiple StorageRepository instances to route
 * read operations per source and write operations to a designated repository.
 */
export class MultiRepository implements StorageRepository {
  private defaultRepository?: StorageRepository;
  private sourceRepositories?: Record<string, StorageRepository>;
  private writeRepository: StorageRepository;
  private resolver?: SourceConfigResolver;

  constructor(
    defaultRepository?: StorageRepository,
    sourceRepositories?: Record<string, StorageRepository>,
    writeRepository?: StorageRepository
  ) {
    this.defaultRepository = defaultRepository;
    this.sourceRepositories = sourceRepositories;
    this.writeRepository = writeRepository ?? defaultRepository!;
  }

  setResolver(resolver: SourceConfigResolver): void {
    this.resolver = resolver;
    if (
      this.defaultRepository &&
      typeof this.defaultRepository.setResolver === "function"
    ) {
      this.defaultRepository.setResolver(resolver);
    }
    if (this.sourceRepositories) {
      for (const repo of Object.values(this.sourceRepositories)) {
        if (repo && typeof repo.setResolver === "function") {
          repo.setResolver(resolver);
        }
      }
    }
    if (
      this.writeRepository &&
      typeof this.writeRepository.setResolver === "function"
    ) {
      this.writeRepository.setResolver(resolver);
    }
  }

  private getReadRepositoryForPattern(pattern: string): StorageRepository {
    if (this.resolver && this.sourceRepositories) {
      for (const [name, rsc] of Object.entries(this.resolver.resolveAll())) {
        if (rsc.pattern === pattern) {
          const repo = this.sourceRepositories[name];
          if (repo) {
            return repo;
          }
        }
      }
    }
    if (this.defaultRepository) {
      return this.defaultRepository;
    }
    throw new Error(`MultiRepository: no repository found for pattern: ${pattern}`);
  }

  private getReadRepositoryForPath(path: string): StorageRepository {
    if (this.resolver && this.sourceRepositories) {
      for (const { name, pattern } of this.resolver.resolveAll()) {
        if (SourceConfigResolver.patternTest(pattern, path)) {
          const repo = this.sourceRepositories[name];
          if (repo) {
            return repo;
          }
          break;
        }
      }
    }
    if (this.defaultRepository) {
      return this.defaultRepository;
    }
    throw new Error(`MultiRepository: no repository found for path: ${path}`);
  }

  async listFiles(pattern: string): Promise<string[]> {
    const repo = this.getReadRepositoryForPattern(pattern);
    return repo.listFiles(pattern);
  }

  async readFile(path: string): Promise<string> {
    const repo = this.getReadRepositoryForPath(path);
    return repo.readFile(path);
  }

  async openFileStream(path: string): Promise<ReadableStream> {
    const repo = this.getReadRepositoryForPath(path);
    return repo.openFileStream(path);
  }

  async exists(path: string): Promise<boolean> {
    const repo = this.getReadRepositoryForPath(path);
    return repo.exists(path);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    return this.writeRepository.writeFile(path, data);
  }

  async removeFile(path: string): Promise<void> {
    return this.writeRepository.removeFile(path);
  }

  async removeDir(path: string): Promise<void> {
    return this.writeRepository.removeDir(path);
  }
}