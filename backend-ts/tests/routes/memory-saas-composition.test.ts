import { describe, expect, it, vi } from "vitest";

import { buildApp, type BuildAppOptions } from "../../src/app.js";
import type { TransactionalMemoryRepository } from "../../src/contracts/memory-store/index.js";
import { SaaSMemoryContextSource } from "../../src/services/agent/memory/saas-memory-context-source.js";
import type { MemoryApplication } from "../../src/services/memory/index.js";
import type { SaaSMemoryRuntimeHandle } from "../../src/services/runtime/saas-memory-runtime.js";
import { SaaSRuntimeProvider } from "../../src/services/runtime/saas-runtime-provider.js";
import { SaaSMemoryToolService } from "../../src/tools/MemoryTools/SaaSMemoryExecution.js";
import { testEnv } from "../helpers/app.js";
import { makeTempRoot } from "../helpers/temp-db.js";

describe("SaaS memory application composition", () => {
  it("routes governance through the SaaS provider and closes its runtime handle", async () => {
    const memory: MemoryApplication = {
      query: {} as MemoryApplication["query"],
      commands: {} as MemoryApplication["commands"],
      governance: {
        countCandidates: vi.fn(async () => 0),
        listCandidates: vi.fn(async () => []),
      } as unknown as MemoryApplication["governance"],
    };
    const provider = new SaaSRuntimeProvider({} as TransactionalMemoryRepository);
    const memoryForTenant = vi.spyOn(provider, "memoryForTenant").mockReturnValue(memory);
    const close = vi.fn(async () => undefined);
    const handle = {
      provider,
      repository: {} as SaaSMemoryRuntimeHandle["repository"],
      close,
    } satisfies SaaSMemoryRuntimeHandle;
    const root = makeTempRoot();
    const app = await buildApp({
      env: {
        ...testEnv,
        dataRoot: root,
        systemRoot: `${root}/system`,
        tenantsRoot: `${root}/tenants`,
      },
      saasMemoryRuntime: handle,
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/memory/candidates?target_scope=team",
      });

      expect(response.statusCode).toBe(200);
      expect(memoryForTenant).toHaveBeenCalledWith("tnt_local");
      expect(memory.governance.countCandidates).toHaveBeenCalled();
      expect(memory.governance.listCandidates).toHaveBeenCalled();
    } finally {
      await app.close();
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it("injects SaaS memory tools and context through buildApp's default registry", async () => {
    const root = makeTempRoot();
    const provider = new SaaSRuntimeProvider({} as TransactionalMemoryRepository);
    const createMemoryBindings = vi.spyOn(provider, "createMemoryBindings");
    const close = vi.fn(async () => undefined);
    const handle = {
      provider,
      repository: {} as SaaSMemoryRuntimeHandle["repository"],
      close,
    } satisfies SaaSMemoryRuntimeHandle;
    const app = await buildApp({
      env: {
        ...testEnv,
        dataRoot: root,
        systemRoot: `${root}/system`,
        tenantsRoot: `${root}/tenants`,
      },
      saasMemoryRuntime: handle,
    });
    await app.ready();
    try {
      const response = await app.inject({ method: "GET", url: "/api/agent/agents" });

      expect(response.statusCode).toBe(200);
      expect(createMemoryBindings).toHaveBeenCalledOnce();
      expect(createMemoryBindings).toHaveBeenCalledWith("tnt_local", expect.any(Object));
      const bindings = createMemoryBindings.mock.results[0]?.value;
      expect(bindings?.tools).toBeInstanceOf(SaaSMemoryToolService);
      expect(bindings?.createContextSource({
        sessions: { getSession: () => null },
        memory: {
          auto_inject: true,
          allowed_scopes: ["session"],
          write_scopes: [],
          archive_scopes: [],
        },
        agentName: "orchestrator_agent",
        memoryConfig: { index_max_lines: 100, index_max_chars: 1_000 },
        dataRoot: root,
      })).toBeInstanceOf(SaaSMemoryContextSource);
    } finally {
      await app.close();
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects custom composition that could split route and Agent memory backends", async () => {
    const provider = new SaaSRuntimeProvider({} as TransactionalMemoryRepository);
    const handle = {
      provider,
      repository: {} as SaaSMemoryRuntimeHandle["repository"],
      close: vi.fn(async () => undefined),
    } satisfies SaaSMemoryRuntimeHandle;

    await expect(buildApp({
      env: testEnv,
      saasMemoryRuntime: handle,
      registry: {} as NonNullable<BuildAppOptions["registry"]>,
    })).rejects.toThrow("split Memory backends");
    await expect(buildApp({
      env: testEnv,
      saasMemoryRuntime: handle,
      resolveMemoryApplication: async () => undefined,
    })).rejects.toThrow("split Memory backends");
  });
});
