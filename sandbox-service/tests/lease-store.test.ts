import { describe, expect, it, vi } from "vitest";

import type { DockerSandboxEngine } from "../src/docker-cli.js";
import { SandboxCapacityError, SandboxLeaseStore } from "../src/lease-store.js";

describe("sandbox lease capacity", () => {
  it("reserves capacity while a container is still being created", async () => {
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const engine = {
      create: vi.fn(async () => {
        await createGate;
        return {
          id: "a".repeat(32),
          owner: owner("run-1"),
          containerName: "container",
          inputVolume: "input",
          workVolume: "work",
          outputVolume: "output",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      }),
      destroy: vi.fn(async () => undefined),
    } as unknown as DockerSandboxEngine;
    const store = new SandboxLeaseStore(engine, 1);

    const first = store.create(owner("run-1"), 60);
    await vi.waitFor(() => expect(engine.create).toHaveBeenCalledTimes(1));
    await expect(store.create(owner("run-2"), 60)).rejects.toBeInstanceOf(SandboxCapacityError);

    releaseCreate?.();
    const lease = await first;
    await store.destroy(lease.id);
  });
});

function owner(runId: string) {
  return {
    tenantId: "tenant-1",
    userId: "user-1",
    sessionId: "session-1",
    runId,
  };
}
