import { LlmProviderClient, type ProviderConfig } from "@ragsystem/agent-llm";

import type { AgentLlmConfig } from "../../contracts/agent/agent-config.js";
import type { ModelProviderConfig } from "../../contracts/integrations/model-adapter.js";
import type { SystemLlmConfig } from "../../contracts/runtime/system-config.js";
import { findProviderByRef } from "../runtime/provider-lookup.js";

/** 列表 title 列与派生兜底（首条消息截 30 字符）共用同一上限，LLM 标题不突破列表展示语义。 */
export const SESSION_TITLE_MAX_LENGTH = 30;

/**
 * 智能体档位候选顺序，与上下文压缩的摘要解析一致：fast 优先、default 兜底。
 * 全部不可用时回落系统 LLM（无 tier 的系统 Agent 即此常态）。
 */
const AGENT_TIER_CANDIDATES = ["fast", "default"] as const;

/** 解析后的调用目标（provider 引用三元组）。 */
interface TitleLlmRef {
  provider: string;
  provider_type: string;
  model_name: string;
}

/** 送给模型的消息文本上限：标题只关心意图，超长输入徒增时延与费用。 */
const TITLE_INPUT_MAX_CHARS = 2_000;

/** 单次生成的整体超时：标题是旁路任务，任何慢 provider 都不能拖住进程退出之外的任何事。 */
const TITLE_GENERATION_TIMEOUT_MS = 15_000;

/** LLM 生成标题的产出 token 上限。标题本身 ≤30 字符；额外预算兜底不支持关闭思考的
 *  模型（思考块不计入 sanitize，只取正文），避免思考耗尽预算后正文为空。 */
const TITLE_MAX_COMPLETION_TOKENS = 512;

const TITLE_SYSTEM_PROMPT = [
  "你是一个聊天应用的会话标题生成器。",
  "根据用户发给助手的第一条消息生成一个简短的会话标题。",
  "要求：直接输出标题本身，不加引号、标点结尾或任何解释；",
  "中文不超过 12 个字，英文不超过 8 个单词，与消息语言一致；",
  "消息只是问候或没有实质内容时，直接用消息原文概括。",
].join("");

/** LlmProviderClient 无状态；可注入替身仅为测试。 */
export interface SessionTitleLlmClient {
  complete(request: Parameters<LlmProviderClient["complete"]>[0]): Promise<{ content: string }>;
}

export interface SessionTitleServiceDeps {
  /** 回写会话列表投影（title_override 与展示 title 同步落）。 */
  updateSessionListTitle(sessionId: string, title: string): void | Promise<void>;
  systemConfig: { getLlmConfig(): SystemLlmConfig };
  modelProviders: { listProviders(): ModelProviderConfig[] };
  /**
   * 会话 → 智能体 llm_tiers 解析（通常经 team snapshot 的入口 Agent）。
   * 缺省 / 返回空 / 抛错 → 回落系统 LLM。标题是旁路任务：档位引用解析不到
   * 时不做显式报缺失（与执行期 Agent 配置的严格语义刻意不同）。
   */
  getAgentLlmTiers?: ((sessionId: string) =>
    | Promise<Record<string, AgentLlmConfig> | null>
    | Record<string, AgentLlmConfig> | null) | null;
  llmClient?: SessionTitleLlmClient;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void } | null;
}

/** 剥尾部句读（LLM 常无视"不加标点结尾"的要求）。 */
const TRAILING_PUNCTUATION = /[。．.!！?？;；,，、…\s]+$/u;

/**
 * 取首个非空行（LLM 输出常带前导换行）、剥尾部句读与包裹引号、压空白并按字符数截断
 * （Array.from 避免 UTF-16 代理对被劈半）。
 */
export function sanitizeSessionTitle(raw: string): string {
  let text = String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  const quotePairs: Array<[string, string]> = [["\"", "\""], ["'", "'"], ["「", "」"], ["『", "』"], ["“", "”"], ["‘", "’"], ["`", "`"]];
  for (let round = 0; round < 2 && text; round += 1) {
    text = text.replace(TRAILING_PUNCTUATION, "");
    const pair = quotePairs.find(([open, close]) => text.length >= 2 && text.startsWith(open) && text.endsWith(close));
    if (pair) {
      text = text.slice(1, -1).trim();
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, SESSION_TITLE_MAX_LENGTH).join("");
}

/**
 * 首条可见用户消息落库后的异步标题生成。
 *
 * 触发方是各部署端的存储适配器（在"本会话第一条可见用户消息"确立的精确时刻通知），
 * 本服务只做三件事：解析调用目标（智能体 fast → default 档，回落系统 LLM）→
 * 一次性补全 → 经端口回写投影。任何失败都静默退回首条消息截断的派生兜底，
 * 绝不影响消息写入路径。
 */
export class SessionTitleService {
  private readonly llmClient: SessionTitleLlmClient;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionTitleServiceDeps) {
    this.llmClient = deps.llmClient ?? new LlmProviderClient();
  }

  /**
   * 存储层通知入口：fire-and-forget，绝不抛出。
   * 同会话并发通知（极小概率的并发首条消息）按会话去重，后到者直接丢弃。
   */
  notifyFirstVisibleUserMessage(sessionId: string, messageText: string): void {
    if (!sessionId) return;
    if (this.inFlight.has(sessionId)) return;
    const task = this.generateTitle(sessionId, messageText)
      .catch((error: unknown) => {
        this.deps.logger?.warn("session title generation failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.inFlight.delete(sessionId);
      });
    this.inFlight.set(sessionId, task);
  }

  async generateTitle(sessionId: string, messageText: string): Promise<void> {
    const text = String(messageText ?? "").trim().slice(0, TITLE_INPUT_MAX_CHARS);
    if (!text) return;

    const resolved = await this.resolveLlm(sessionId);
    if (!resolved) return;

    const response = await this.llmClient.complete({
      messages: [
        { role: "system", content: TITLE_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      model: resolved.ref.model_name,
      // agent-llm 按 API 格式分发：与 testProvider 相同的桥接替换（ModelProviderConfig.key
      // 可选，桥接后形状经 cast 对齐 ProviderConfig）。
      provider: { ...resolved.provider, provider_type: resolved.provider.api_format ?? resolved.provider.provider_type } as unknown as ProviderConfig,
      // 温度与产出上限不取档位值：标题要的是确定性短输出，档位参数为对话调优。
      // 思考必须显式关闭——fast 档常是默认开思考的轻量模型（如 glm flash），
      // 小预算下思考块会耗尽 max_completion_tokens 导致正文为空。
      temperature: 0.2,
      thinkingLevel: "off",
      maxCompletionTokens: TITLE_MAX_COMPLETION_TOKENS,
      signal: AbortSignal.timeout(TITLE_GENERATION_TIMEOUT_MS),
    });

    const title = sanitizeSessionTitle(response.content);
    if (!title) return;
    await this.deps.updateSessionListTitle(sessionId, title);
  }

  /**
   * 调用目标解析：候选链 [智能体 fast, 智能体 default, 系统 LLM]，取第一个能在
   * providers 清单里解析到的（指向已删除 provider 的档位顺位降级，对齐摘要解析）。
   */
  private async resolveLlm(sessionId: string): Promise<{ ref: TitleLlmRef; provider: ModelProviderConfig } | null> {
    const tiers = await this.readAgentTiers(sessionId);
    const candidates: TitleLlmRef[] = [];
    for (const tierName of AGENT_TIER_CANDIDATES) {
      const tier = tiers?.[tierName];
      if (!tier) continue;
      const provider = String(tier.provider ?? "").trim();
      const model_name = String(tier.model_name ?? "").trim();
      // 半空条目（缺 provider 或 model，Agent Studio 表单的落盘形态）不进候选。
      if (!provider || !model_name) continue;
      candidates.push({ provider, provider_type: String(tier.provider_type ?? "").trim(), model_name });
    }
    const systemLlm = this.deps.systemConfig.getLlmConfig();
    if (systemLlm.provider.trim() && systemLlm.model_name.trim()) {
      candidates.push({
        provider: systemLlm.provider,
        provider_type: systemLlm.provider_type,
        model_name: systemLlm.model_name,
      });
    }
    const providers = this.deps.modelProviders.listProviders();
    for (const ref of candidates) {
      const provider = findProviderByRef(providers, ref);
      if (provider) return { ref, provider };
    }
    return null;
  }

  private async readAgentTiers(sessionId: string): Promise<Record<string, AgentLlmConfig> | null> {
    if (!this.deps.getAgentLlmTiers) return null;
    try {
      return await this.deps.getAgentLlmTiers(sessionId);
    } catch {
      // 旁路任务：解析异常回落系统 LLM。
      return null;
    }
  }
}
