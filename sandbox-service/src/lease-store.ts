import type { DockerSandboxEngine } from "./docker-cli.js";
import type { SandboxLeaseRecord, SandboxOwner } from "./types.js";

export class SandboxLeaseStore {
  private readonly leases = new Map<string, SandboxLeaseRecord>();
  private readonly destroys = new Map<string, Promise<void>>();
  private closing = false;
  private pendingCreates = 0;

  constructor(
    private readonly engine: DockerSandboxEngine,
    private readonly maxActiveLeases = 8,
  ) {}

  async create(owner: SandboxOwner, timeoutSeconds: number): Promise<SandboxLeaseRecord> {
    if (this.closing) throw new Error("Sandbox service is shutting down");
    if (this.leases.size + this.pendingCreates >= this.maxActiveLeases) {
      throw new SandboxCapacityError(this.maxActiveLeases);
    }
    this.pendingCreates += 1;
    try {
      const created = await this.engine.create(owner, timeoutSeconds);
      const expiresTimer = setTimeout(() => {
        void this.destroy(created.id).catch(() => undefined);
      }, timeoutSeconds * 1_000);
      expiresTimer.unref();
      const lease: SandboxLeaseRecord = { ...created, expiresTimer };
      this.leases.set(lease.id, lease);
      return lease;
    } finally {
      this.pendingCreates -= 1;
    }
  }

  require(id: string): SandboxLeaseRecord {
    const lease = this.leases.get(id);
    if (!lease || this.destroys.has(id)) throw new SandboxNotFoundError(id);
    if (Date.parse(lease.expiresAt) <= Date.now()) {
      void this.destroy(id).catch(() => undefined);
      throw new SandboxNotFoundError(id);
    }
    return lease;
  }

  async destroy(id: string): Promise<void> {
    const existingDestroy = this.destroys.get(id);
    if (existingDestroy) return existingDestroy;
    const lease = this.leases.get(id);
    if (!lease) return;
    const destroyPromise = this.engine.destroy(lease)
      .then(() => {
        this.leases.delete(id);
        clearTimeout(lease.expiresTimer);
      })
      .catch((error: unknown) => {
        if (!this.closing) {
          clearTimeout(lease.expiresTimer);
          lease.expiresTimer = setTimeout(() => {
            void this.destroy(id).catch(() => undefined);
          }, 30_000);
          lease.expiresTimer.unref();
        }
        throw error;
      })
      .finally(() => {
        this.destroys.delete(id);
      });
    this.destroys.set(id, destroyPromise);
    return destroyPromise;
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    const ids = [...this.leases.keys()];
    await Promise.allSettled(ids.map((id) => this.destroy(id)));
  }
}

export class SandboxNotFoundError extends Error {
  constructor(readonly sandboxId: string) {
    super("Sandbox not found or expired");
    this.name = "SandboxNotFoundError";
  }
}

export class SandboxCapacityError extends Error {
  constructor(readonly maxActiveLeases: number) {
    super("Sandbox service capacity is exhausted");
    this.name = "SandboxCapacityError";
  }
}
