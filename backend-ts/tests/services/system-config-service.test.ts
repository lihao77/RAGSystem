import { describe, expect, it } from "vitest";

import { SystemConfigService } from "../../src/services/config/system-config-service.js";

// configPath: "" 且无 dataRoot → configPath 解析为 null → 纯内存态(不读写磁盘文件),
// updateConfig 的 saveConfig 在 configPath 为 null 时 no-op,不污染测试环境。
function createInMemoryService(): SystemConfigService {
  return new SystemConfigService({ configPath: "" });
}

describe("SystemConfigService 类型化 getter", () => {
  it("空配置时返回与 buildDefaultConfig 一致的默认值", () => {
    const service = createInMemoryService();
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

  it("自定义值经 getter 生效(补接线验证:配置值不再被硬编码忽略)", () => {
    const service = createInMemoryService();
    service.updateConfig({
      tools: { code_default_timeout: 90, code_max_timeout: 500 },
      memory: { index_max_lines: 50, index_max_chars: 12000 },
      system: { max_content_length: 50000000 },
    });
    expect(service.getToolsConfig()).toMatchObject({ code_default_timeout: 90, code_max_timeout: 500 });
    expect(service.getMemoryConfig()).toMatchObject({ index_max_lines: 50, index_max_chars: 12000 });
    expect(service.getSystemGroupConfig().max_content_length).toBe(50000000);
  });

  it("非法/缺失字段回退默认值(兼容 Python 写回的不完整 yaml)", () => {
    const service = createInMemoryService();
    service.updateConfig({
      tools: { code_default_timeout: "invalid", bash_max_timeout: -5 },
    });
    const tools = service.getToolsConfig();
    expect(tools.code_default_timeout).toBe(60); // 非字符串 → 默认
    expect(tools.bash_max_timeout).toBe(600); // 负数 → 默认
    expect(tools.code_max_timeout).toBe(300); // 缺失 → 默认
    expect(tools.bash_default_timeout).toBe(120); // 未覆盖 → 默认
    service.updateConfig({ memory: { index_max_lines: -1, index_max_chars: "invalid" } });
    expect(service.getMemoryConfig()).toEqual({ index_max_lines: 200, index_max_chars: 25600 });
  });
});
