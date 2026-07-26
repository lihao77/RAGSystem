import path from "node:path";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { MemoryToolOperations } from "../../../src/tools/MemoryTools/MemoryExecution.js";
import { createTenantId } from "../../../src/identity/types.js";
import { HashFallbackEmbedder } from "../../../src/services/integrations/embedder-registry.js";
import { AgentCompressionService } from "../../../src/services/agent/context-compression/compression-service.js";
import { AgentDelegationService } from "../../../src/services/agent/delegation/index.js";
import { AgentMetricsCollector } from "../../../src/services/agent/metrics/metrics-collector.js";
import { PermissionPolicyService } from "../../../src/services/runtime/permission-policy-service.js";
import {
  createLocalRuntimeContainer,
} from "../../../src/adapters/local/runtime-container.js";
import { createConversationStore } from "../../../src/adapters/local/sqlite/conversation-store/index.js";
import type {
  CoreRuntimeDependencies,
  LocalRuntimeCapabilities,
  LocalRuntimeContainer,
  SaaSRuntimeCapabilities,
  SaaSRuntimeContainer,
} from "../../../src/contracts/runtime/runtime-container.js";
import type {
  AgentDelegationStorePort,
  AgentMetricsStorePort,
  CompressionHistoryPort,
  PermissionPolicyStorePort,
  RuntimeEventDispatcherPort,
} from "../../../src/contracts/runtime/core-runtime-ports.js";
import type { SessionFileLookupPort } from "../../../src/contracts/session/session-file-storage.js";
import type { LocalRuntimeContainerOptions } from "../../../src/adapters/local/runtime-options.js";
import { makeTempDb, makeTempRoot } from "../../helpers/temp-db.js";

describe("runtime composition roots", () => {
  it("separates deployment capabilities from the shared runtime", () => {
    expectTypeOf<LocalRuntimeContainer["local"]>().toEqualTypeOf<LocalRuntimeCapabilities>();
    expectTypeOf<LocalRuntimeContainer["saas"]>().toEqualTypeOf<null>();
    expectTypeOf<SaaSRuntimeContainer["local"]>().toEqualTypeOf<null>();
    expectTypeOf<SaaSRuntimeContainer["saas"]>().toEqualTypeOf<SaaSRuntimeCapabilities>();
  });

  it("exposes narrow persistence ports for shared runtime services", () => {
    expectTypeOf<CoreRuntimeDependencies["delegationStore"]>().toEqualTypeOf<AgentDelegationStorePort>();
    expectTypeOf<CoreRuntimeDependencies["metricsStore"]>().toEqualTypeOf<AgentMetricsStorePort>();
    expectTypeOf<CoreRuntimeDependencies["permissionPolicyStore"]>().toEqualTypeOf<PermissionPolicyStorePort>();
    expectTypeOf<CoreRuntimeDependencies["compressionHistory"]>().toEqualTypeOf<CompressionHistoryPort>();
    expectTypeOf<CoreRuntimeDependencies["sessionFiles"]>().toEqualTypeOf<SessionFileLookupPort>();
    expectTypeOf<CoreRuntimeDependencies["eventDispatcher"]>().toEqualTypeOf<RuntimeEventDispatcherPort>();
    expectTypeOf<ConstructorParameters<typeof AgentDelegationService>[0]>().toEqualTypeOf<AgentDelegationStorePort>();
    expectTypeOf<ConstructorParameters<typeof AgentMetricsCollector>[0]>().toEqualTypeOf<AgentMetricsStorePort>();
    expectTypeOf<ConstructorParameters<typeof PermissionPolicyService>[0]>().toEqualTypeOf<PermissionPolicyStorePort>();
    expectTypeOf<ConstructorParameters<typeof AgentCompressionService>[0]>().toEqualTypeOf<CompressionHistoryPort>();
  });

  it("local entrypoint creates the runtime contract", async () => {
    const factory = createLocalRuntimeContainer;
    const dataRoot = makeTempRoot();
    const options: LocalRuntimeContainerOptions = {
      tenantId: createTenantId("tnt_runtime_composition"),
      dbPath: ":memory:",
      dataRoot,
      modelAdapterProvidersConfigPath: "",
      mcpConfigPath: "",
      systemConfigPath: "",
      startOutboxDispatcher: false,
      embedderFactory: () => new HashFallbackEmbedder(),
    };

    const runtime = await factory(options);
    try {
      expect(runtime.dataRoot).toBe(path.resolve(dataRoot));
      expect(runtime.agentExecution).toBeDefined();
      expect(runtime.runtimeCore).toBeDefined();
      expect(runtime.local.analytics).toBeDefined();
      expect(runtime.local.monitoring).toBeDefined();
      expect(runtime.local.sessionFiles).toBeDefined();
    } finally {
      runtime.close();
      expect(() => runtime.close()).not.toThrow();
    }
  });

  it("recovers runs orphaned by a previous local backend process", async () => {
    const tenantId = createTenantId("tnt_runtime_restart_recovery");
    const dbPath = makeTempDb();
    const dataRoot = path.dirname(dbPath);
    const previous = createConversationStore({ dbPath, dataRoot });
    previous.createSession({ tenantId: tenantId, sessionId: "restart-session", ownerUserId: "user-1", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    previous.createRun({
      runId: "orphaned-root",
      sessionId: "restart-session",
      status: "running",
      threadKey: "root",
    });
    previous.createRun({
      runId: "orphaned-child",
      sessionId: "restart-session",
      status: "running",
      threadKey: "child:worker",
      parentRunId: "orphaned-root",
      childAgentId: "worker",
    });
    previous.close();

    const runtime = await createLocalRuntimeContainer({
      tenantId,
      dbPath,
      dataRoot,
      modelAdapterProvidersConfigPath: "",
      mcpConfigPath: "",
      systemConfigPath: "",
      startOutboxDispatcher: false,
      hostToolsEnabled: false,
      embedderFactory: () => new HashFallbackEmbedder(),
    });
    try {
      const status = await runtime.local.executionRead.getSessionTaskStatus("restart-session");
      expect(status.has_running_task).toBe(false);
      expect(status.task_info).toMatchObject({ run_id: "orphaned-root", status: "interrupted", thread_alive: false });
      const runs = await runtime.local.executionRead.listRuns("restart-session", 10);
      expect(runs).toEqual(expect.arrayContaining([
        expect.objectContaining({ run_id: "orphaned-root", status: "interrupted" }),
        expect.objectContaining({ run_id: "orphaned-child", status: "interrupted" }),
      ]));
      const outbox = await runtime.local.monitoring.listOutbox({ limit: 20 });
      expect(outbox.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          run_id: "orphaned-root",
          event_type: "client.run_ended",
          status: "delivered",
        }),
      ]));
    } finally {
      runtime.close();
    }
  });

  it("uses deployment-provided memory bindings without changing the local repository", async () => {
    const dataRoot = makeTempRoot();
    const memoryTools = { marker: "postgres" } as unknown as MemoryToolOperations;
    let boundTenantId = "";
    const runtime = await createLocalRuntimeContainer({
      tenantId: createTenantId("tnt_runtime_memory_bindings"),
      dbPath: ":memory:",
      dataRoot,
      modelAdapterProvidersConfigPath: "",
      mcpConfigPath: "",
      systemConfigPath: "",
      startOutboxDispatcher: false,
      embedderFactory: () => new HashFallbackEmbedder(),
      memoryBindingsFactory: (input) => {
        boundTenantId = input.tenantId;
        return {
          tools: memoryTools,
          createContextSource: () => ({
            name: "memory",
            build: async () => ({ conversation: [] }),
          }),
        };
      },
    });
    try {
      expect(boundTenantId).toBe("tnt_runtime_memory_bindings");
      expect(runtime.memoryTools).toBe(memoryTools);
      expect(runtime.local.createMemoryApplication).toBeTypeOf("function");
    } finally {
      runtime.close();
    }
  });

  it("can disable host filesystem and process tools for SaaS composition", async () => {
    const dataRoot = makeTempRoot();
    const runtime = await createLocalRuntimeContainer({
      tenantId: createTenantId("tnt_runtime_host_tools_disabled"),
      dbPath: ":memory:",
      dataRoot,
      startOutboxDispatcher: false,
      hostToolsEnabled: false,
    });
    try {
      expect(runtime.bashTools).toBeNull();
      expect(runtime.documentTools).toBeNull();
      expect(runtime.codeExecutionTools).toBeNull();
      expect(runtime.searchTools).toBeNull();
    } finally {
      runtime.close();
    }
  });

  it("routes SaaS execution events through the deployment-provided durable publisher", async () => {
    const dataRoot = makeTempRoot();
    const publish = vi.fn().mockResolvedValue({});
    let factoryTenantId = "";
    let factoryRealtimeEvents: unknown;
    const runtime = await createLocalRuntimeContainer({
      tenantId: createTenantId("tnt_runtime_durable_events"),
      dbPath: ":memory:",
      dataRoot,
      startOutboxDispatcher: false,
      hostToolsEnabled: false,
      clientEventsFactory: (tenantId, realtimeEvents) => {
        factoryTenantId = tenantId;
        factoryRealtimeEvents = realtimeEvents;
        return { publish } as never;
      },
    });
    try {
      const eventPublisher = (runtime.agentExecution as typeof runtime.agentExecution & {
        eventPublisher: { publishRunStarted(sessionId: string, runId: string, payload: Record<string, string>): void };
      }).eventPublisher;
      eventPublisher.publishRunStarted("session-1", "run-1", { source: "daemon.feishu.incoming" });

      await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({ type: "run_started", run_id: "run-1" }),
        { runId: "run-1", aggregateType: "run", aggregateId: "run-1", requireRunLease: true },
      ));
      expect((await runtime.local.monitoring.listOutbox({ limit: 10 })).items).toEqual([]);
      expect(factoryTenantId).toBe("tnt_runtime_durable_events");
      expect(factoryRealtimeEvents).toBe(runtime.realtimeEvents);
    } finally {
      runtime.close();
    }
  });
});
