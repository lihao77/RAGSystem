import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeContainer } from "../../../src/contracts/runtime/runtime-container.js";
import type { SaaSConversationRuntimeHandle } from "../../../src/adapters/saas/composition/saas-conversation-runtime.js";
import { prepareSaaSRuntimeContainer } from "../../../src/adapters/saas/composition/saas-runtime-container.js";

describe("SaaS runtime container composition", () => {
  it("does not depend on the Local runtime bootstrap", () => {
    const source = fs.readFileSync(
      path.resolve("src/adapters/saas/composition/saas-runtime-container.ts"),
      "utf8",
    );

    expect(source).not.toContain("createLocalRuntimeContainer");
    expect(source).not.toContain("createConversationStore");
    expect(source).not.toContain("FileIndexService");
    expect(source).not.toContain("createVectorStoreFromConfig");
    expect(source).toContain("createRuntimeStorage");
    expect(source).toContain("createDelegationStore");
    expect(source).toContain("createAgentConfigTeamStore");
    expect(source).toContain("sharedOutboxDispatcher");
    expect(source).toContain("dropMcpRuntime");
    expect(source).not.toContain("FileAgentConfigTeamStore");
  });

  it("refreshes tenant provider configuration before use", async () => {
    const replaceRuntimeProviders = vi.fn();
    const listProviders = vi.fn(async () => [{ id: "provider-a" }]);
    const reload = vi.fn(async () => undefined);
    const runtime = {
      deploymentKind: "saas",
      modelAdapter: { replaceRuntimeProviders },
      systemConfig: { reload },
    } as unknown as RuntimeContainer;
    const conversationRuntime = {
      providerMcpApplication: { listProviders },
    } as unknown as SaaSConversationRuntimeHandle;

    await prepareSaaSRuntimeContainer("tenant-a" as never, runtime, conversationRuntime);

    expect(listProviders).toHaveBeenCalledWith("tenant-a");
    expect(replaceRuntimeProviders).toHaveBeenCalledWith([{ id: "provider-a" }]);
    expect(reload).toHaveBeenCalled();
  });
});
