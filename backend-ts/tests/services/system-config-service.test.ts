import { describe, expect, it } from "vitest";

import type { SystemConfigData } from "../../src/contracts/runtime/system-config.js";
import type { ISystemConfigStore } from "../../src/contracts/runtime/system-config-store.js";
import { SystemConfigService } from "../../src/services/config/system-config-service.js";

/** In-memory store: null load / save to map — SaaS-style projection without disk. */
class MemorySystemConfigStore implements ISystemConfigStore {
  private document: SystemConfigData | null = null;

  async load(): Promise<SystemConfigData | null> {
    return this.document ? structuredClone(this.document) : null;
  }

  async save(config: SystemConfigData): Promise<void> {
    this.document = structuredClone(config);
  }
}

async function createInMemoryService(): Promise<SystemConfigService> {
  const service = new SystemConfigService(new MemorySystemConfigStore());
  await service.initialize();
  return service;
}

describe("SystemConfigService 类型化 getter", () => {
  it("空配置时返回与 buildDefaultConfig 一致的默认值", async () => {
    const service = await createInMemoryService();
    expect(service.getToolsConfig()).toEqual({
      bash_default_timeout: 120,
      bash_max_timeout: 600,
      bash_max_output: 50000,
      code_default_timeout: 60,
      code_max_timeout: 300,
    });
    expect(service.getMemoryConfig()).toEqual({
      index_max_lines: 200,
      index_max_chars: 25600,
    });
    expect(service.getSystemGroupConfig()).toEqual({ max_content_length: 104857600 });
  });

  it("自定义值经 getter 生效(补接线验证:配置值不再被硬编码忽略)", async () => {
    const service = await createInMemoryService();
    await service.updateConfig({
      tools: { code_default_timeout: 90, code_max_timeout: 500 },
      memory: { index_max_lines: 50, index_max_chars: 12000 },
      system: { max_content_length: 50000000 },
    });
    expect(service.getToolsConfig()).toMatchObject({ code_default_timeout: 90, code_max_timeout: 500 });
    expect(service.getMemoryConfig()).toMatchObject({ index_max_lines: 50, index_max_chars: 12000 });
    expect(service.getSystemGroupConfig().max_content_length).toBe(50000000);
  });

  it("非法/缺失字段回退默认值(兼容 Python 写回的不完整 yaml)", async () => {
    const service = await createInMemoryService();
    await service.updateConfig({
      tools: { code_default_timeout: "invalid", bash_max_timeout: -5 },
    });
    const tools = service.getToolsConfig();
    expect(tools.code_default_timeout).toBe(60); // 非数字 → 默认
    expect(tools.bash_max_timeout).toBe(600); // 负数 → 默认
    expect(tools.code_max_timeout).toBe(300); // 缺失 → 默认
    expect(tools.bash_default_timeout).toBe(120); // 未覆盖 → 默认
    await service.updateConfig({ memory: { index_max_lines: -1, index_max_chars: "invalid" } });
    expect(service.getMemoryConfig()).toEqual({ index_max_lines: 200, index_max_chars: 25600 });
  });

  it("writes through the store then reloads the projection from the store", async () => {
    const store = new MemorySystemConfigStore();
    const service = new SystemConfigService(store);
    await service.initialize();
    await service.updateConfig({ memory: { index_max_lines: 33 } });
    expect((await store.load())?.memory).toMatchObject({ index_max_lines: 33 });

    const reloaded = new SystemConfigService(store);
    await reloaded.initialize();
    expect(reloaded.getMemoryConfig().index_max_lines).toBe(33);
  });
});
