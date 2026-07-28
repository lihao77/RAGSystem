import type { MemoryToolRepositoryPort } from "@ragsystem/backend-core/contracts/memory-store/index.js";
import type { MemoryStore } from "./memory-store.js";

/** Adapts the synchronous Local filesystem API to the shared Promise-only tool port. */
export class LocalMemoryToolRepository implements MemoryToolRepositoryPort {
  constructor(private readonly memory: MemoryStore) {}

  async loadIndexHead(...args: Parameters<MemoryStore["loadIndexHead"]>) {
    return this.memory.loadIndexHead(...args);
  }

  async readEntryFile(...args: Parameters<MemoryStore["readEntryFile"]>) {
    return this.memory.readEntryFile(...args);
  }

  async saveMemory(...args: Parameters<MemoryStore["saveMemory"]>) {
    return this.memory.saveMemory(...args);
  }

  async archiveMemory(...args: Parameters<MemoryStore["archiveMemory"]>) {
    return this.memory.archiveMemory(...args);
  }

  async getIndexPath(...args: Parameters<MemoryStore["getIndexPath"]>) {
    return this.memory.getIndexPath(...args);
  }
}
