import path from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import type { MemoryRepository } from "../../../src/contracts/memory-store/index.js";
import { createTenantId } from "../../../src/identity/types.js";
import { HashFallbackEmbedder } from "../../../src/services/integrations/embedder-registry.js";
import {
  createLocalRuntimeContainer,
  createRuntimeContainer,
  type CoreRuntimeDependencies,
  type LocalRuntimeContainerOptions,
} from "../../../src/services/runtime/runtime-container.js";
import { makeTempRoot } from "../../helpers/temp-db.js";

describe("runtime composition roots", () => {
  it("keeps the core memory dependency deployment-independent", () => {
    expectTypeOf<CoreRuntimeDependencies["memoryStore"]>().toEqualTypeOf<MemoryRepository>();
  });

  it.each([
    ["legacy", createRuntimeContainer],
    ["local", createLocalRuntimeContainer],
  ] as const)("%s entrypoint creates the same local runtime contract", (_name, factory) => {
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
});
