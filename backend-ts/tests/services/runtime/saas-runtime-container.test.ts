import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeContainer } from "../../../src/contracts/runtime/runtime-container.js";
import type { RuntimeStorage } from "../../../src/contracts/storage/runtime-storage.js";
import type { TenantId } from "../../../src/identity/types.js";
import type { LocalRuntimeContainerOptions } from "../../../src/adapters/local/runtime-options.js";
import type { SaaSConversationRuntimeHandle } from "../../../src/adapters/saas/composition/saas-conversation-runtime.js";
import type { SaaSMemoryRuntimeHandle } from "../../../src/adapters/saas/composition/saas-memory-runtime.js";

const localFactory = vi.hoisted(() => vi.fn());

vi.mock("../../../src/adapters/local/runtime-container.js", () => ({
  createLocalRuntimeContainer: localFactory,
}));

import {
  createSaaSRuntimeContainer,
  prepareSaaSRuntimeContainer,
} from "../../../src/adapters/saas/composition/saas-runtime-container.js";

describe("SaaS runtime container composition", () => {
  beforeEach(() => {
    localFactory.mockReset();
  });

  it("owns all SaaS persistence bindings in one composition root", () => {
    const container = {} as RuntimeContainer;
    const runtimeStorage = {} as RuntimeStorage;
    const memoryBindings = { tools: {}, createContextSource: vi.fn() };
    const conversationRuntime = {
      conversation: { marker: "conversation" },
      providerContinuations: { marker: "continuations" },
      backgroundTasks: { marker: "background" },
      analytics: { marker: "analytics" },
      outbox: { marker: "outbox" },
      createRuntimeStorage: vi.fn(() => runtimeStorage),
      createKnowledgeQuery: vi.fn(() => ({ marker: "knowledge" })),
      createFileHistoryStorage: vi.fn(() => ({ marker: "history" })),
    } as unknown as SaaSConversationRuntimeHandle;
    const memoryRuntime = {
      provider: {
        createMemoryBindings: vi.fn(() => memoryBindings),
      },
    } as unknown as SaaSMemoryRuntimeHandle;
    localFactory.mockReturnValue(container);

    const result = createSaaSRuntimeContainer({
      tenantId: "tenant-a" as TenantId,
      dbPath: ":memory:",
      dataRoot: "data/tenant-a",
      conversationRuntime,
      memoryRuntime,
    });

    expect(result).toBe(container);
    expect(localFactory).toHaveBeenCalledOnce();
    const composed = localFactory.mock.calls[0]![0] as LocalRuntimeContainerOptions;
    expect(composed.hostToolsEnabled).toBe(false);
    expect(composed.asyncConversationHistory).toBe(conversationRuntime.conversation);
    expect(composed.asyncProviderContinuations).toBe(conversationRuntime.providerContinuations);
    expect(composed.asyncBackgroundTasks).toBe(conversationRuntime.backgroundTasks);
    expect(composed.asyncAnalytics).toBe(conversationRuntime.analytics);
    expect(composed.runtimeStorageFactory?.("tenant-a" as TenantId)).toBe(runtimeStorage);
    expect(composed.memoryBindingsFactory?.({
      tenantId: "tenant-a" as TenantId,
      dataRoot: "data/tenant-a",
      memoryConfig: {} as never,
      memoryRepository: {} as never,
      sessions: {} as never,
    })).toBe(memoryBindings);
  });

  it("refreshes tenant provider configuration before use", async () => {
    const replaceRuntimeProviders = vi.fn();
    const listProviders = vi.fn(async () => [{ id: "provider-a" }]);
    const runtime = { modelAdapter: { replaceRuntimeProviders } } as unknown as RuntimeContainer;
    const conversationRuntime = {
      providerMcpApplication: { listProviders },
    } as unknown as SaaSConversationRuntimeHandle;

    await prepareSaaSRuntimeContainer("tenant-a" as TenantId, runtime, conversationRuntime);

    expect(listProviders).toHaveBeenCalledWith("tenant-a");
    expect(replaceRuntimeProviders).toHaveBeenCalledWith([{ id: "provider-a" }]);
  });
});
