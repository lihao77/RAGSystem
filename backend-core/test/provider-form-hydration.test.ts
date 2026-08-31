import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ModelAdapterService } from "../src/services/integrations/model-adapter-service.js";
import { runProviderFormNormalization } from "../src/services/integrations/model-adapter-hydration.js";
import type { ModelProviderConfig } from "../src/contracts/integrations/model-adapter.js";

/**
 * Provider 形态归一层的历史形状夹具：锁住"任何历史版本的持久化条目经水合链
 * 收敛到当前形态且行为不变"。改加载逻辑弄断老用户的迁移链时，这里会先失败。
 */
describe("provider form normalization hydration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("磁盘加载：旧别名 api_format 条目经归一存活，废弃字段剥离，字符串模型丢弃", () => {
    const yaml = [
      "alias_entry:",
      "  name: Alias Gateway",
      "  provider_type: deepseek",
      "  api_format: openai_compatible_chat",
      "  api_key: sk-legacy",
      "  temperature: 0.3",
      "  model_map:",
      "    chat: legacy-chat-model",
      "  models:",
      "    - legacy-chat-model",
      "valid_entry:",
      "  name: Current Form",
      "  provider_type: zhipuai",
      "  api_format: openai_chat",
      "  api_key: sk-current",
      "  models:",
      "    - name: glm-model",
      "      max_context_tokens: 128000",
    ].join("\n");
    const service = loadFromYaml(yaml);

    const alias = service.getProvider("alias_entry");
    // 旧别名归一为 openai_chat（而非被当作未知格式丢弃），废弃字段与字符串模型剥离。
    expect(alias).toMatchObject({
      name: "Alias Gateway",
      provider_type: "deepseek",
      api_format: "openai_chat",
      api_key: "sk-legacy",
      models: [],
    });
    expect(alias).not.toHaveProperty("temperature");
    expect(alias).not.toHaveProperty("model_map");

    expect(service.getProvider("valid_entry")).toMatchObject({
      api_format: "openai_chat",
      models: [{ name: "glm-model", max_context_tokens: 128000 }],
    });
  });

  it("归一链幂等：已是当前形态的条目重复水合结果不变", () => {
    const config: ModelProviderConfig = {
      key: "k",
      name: "Current Form",
      provider_type: "zhipuai",
      api_format: "openai_chat",
      api_key: "sk",
      models: [{ name: "glm-model", max_context_tokens: 128000 }],
      thinking_kind: "toggle",
    };
    const snapshot = JSON.stringify(config);
    runProviderFormNormalization(config);
    runProviderFormNormalization(config);
    expect(JSON.stringify(config)).toBe(snapshot);
  });

  it("运行时快照水合与磁盘水合同口径（replaceRuntimeProviders 复用同一组步骤）", () => {
    const service = new ModelAdapterService();
    service.replaceRuntimeProviders([
      {
        key: "runtime_alias",
        name: "Runtime Alias",
        provider_type: "openai_proxy",
        api_format: "openai_proxy",
        api_key: "sk",
        models: [],
      } as ModelProviderConfig,
    ]);
    expect(service.getProvider("runtime_alias")?.api_format).toBe("openai_chat");
  });

  function loadFromYaml(yaml: string): ModelAdapterService {
    const dir = mkdtempSync(path.join(tmpdir(), "provider-hydration-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "providers.yaml");
    writeFileSync(configPath, yaml, "utf8");
    return new ModelAdapterService({ providersConfigPath: configPath });
  }
});
