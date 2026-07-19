import { describe, expect, it } from "vitest";
import { resolveSessionMetadataPort } from "../../src/services/agent/context/async-session-metadata-resolver.js";
import type { SessionInfo } from "../../src/contracts/session/session.js";

describe("async session metadata resolver", () => {
  it("uses the SaaS snapshot and flushes queued metadata writes", async () => {
    let metadata: Record<string, unknown> = { _provider_cache: { child: { last_used_at: 1 } } };
    const writes: Record<string, unknown>[] = [];
    const session = (): SessionInfo => ({
      session_id: "session-1",
      tenant_id: "tenant-1" as SessionInfo["tenant_id"],
      user_id: "user-1",
      permission_mode: null,
      metadata,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const port = await resolveSessionMetadataPort(
      "session-1",
      {
        getSession: () => { throw new Error("Local session store must not be read"); },
        updateSessionMetadata: () => { throw new Error("Local session store must not be written"); },
      },
      {
        getSession: async () => session(),
        updateSessionMetadata: async (_sessionId, patch) => {
          writes.push(patch);
          metadata = { ...metadata, ...patch };
          return metadata;
        },
      },
    );

    expect(port.getSession("session-1")?.user_id).toBe("user-1");
    port.updateSessionMetadata?.("session-1", { _provider_cache: { root: { last_used_at: 2 } } });
    expect(port.getSession("session-1")?.metadata).toMatchObject({
      _provider_cache: { child: { last_used_at: 1 }, root: { last_used_at: 2 } },
    });
    await port.flush();
    expect(writes).toEqual([{ _provider_cache: { root: { last_used_at: 2 } } }]);
  });
});
