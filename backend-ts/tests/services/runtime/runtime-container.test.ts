import path from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import type { MemoryRepository } from "../../../src/contracts/memory-store/index.js";
import type { MemoryToolOperations } from "../../../src/tools/MemoryTools/MemoryExecution.js";
import { createTenantId } from "../../../src/identity/types.js";
import { HashFallbackEmbedder } from "../../../src/services/integrations/embedder-registry.js";
import {
  createLocalRuntimeContainer,
} from "../../../src/adapters/local/runtime-container.js";
import type { CoreRuntimeDependencies } from "../../../src/contracts/runtime-container.js";
import type { LocalRuntimeContainerOptions } from "../../../src/adapters/local/runtime-options.js";
import { makeTempRoot } from "../../helpers/temp-db.js";

describe("runtime composition roots", () => {
  it("keeps the core memory dependency deployment-independent", () => {
    expectTypeOf<CoreRuntimeDependencies["memoryStore"]>().toEqualTypeOf<MemoryRepository>();
  });

  it("local entrypoint creates the runtime contract", () => {
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

    const runtime = factory(options);
    try {
      expect(runtime.dataRoot).toBe(path.resolve(dataRoot));
      expect(runtime.agentExecution).toBeDefined();
      expect(runtime.runtimeCore).toBeDefined();
      expect(runtime.conversationStore).toBeDefined();
    } finally {
      runtime.close();
      expect(() => runtime.close()).not.toThrow();
    }
  });

  it("uses deployment-provided memory bindings without changing the local repository", () => {
    const dataRoot = makeTempRoot();
    const memoryTools = { marker: "postgres" } as unknown as MemoryToolOperations;
    let boundTenantId = "";
    const runtime = createLocalRuntimeContainer({
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
      expect(runtime.memoryStore).toBeDefined();
    } finally {
      runtime.close();
    }
  });

  it("can disable host filesystem and process tools for SaaS composition", () => {
    const dataRoot = makeTempRoot();
    const runtime = createLocalRuntimeContainer({
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
});
