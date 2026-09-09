import { z } from "zod";

export const ProviderPayloadSchema = z.record(z.unknown());

export const ReorderProvidersRequestSchema = z.object({
  provider_keys: z.array(z.string()),
});

export const TestProviderRequestSchema = z
  .object({
    provider: z.string().optional(),
    provider_type: z.string().optional(),
    model: z.union([z.string(), z.array(z.string())]).optional(),
    prompt: z.string().optional(),
  })
  .catchall(z.unknown());

export interface ProviderConfigFieldOption {
  value: string;
  label: string;
}

export interface ProviderConfigField {
  key: string;
  label: string;
  type: string;
  default: string | number | boolean | null;
  help: string;
  options: ProviderConfigFieldOption[];
  min?: number;
  max?: number;
  step?: number;
}

export interface ProviderTypeInfo {
  /** API 格式 id（openai_resp / openai_chat / anthropic / gemini）。 */
  value: string;
  label: string;
  default_endpoint: string;
  config_fields: ProviderConfigField[];
}

/** 模型模态值域（与 Models.dev 目录对齐）；文本对话是底线能力，输入/输出至少含 text。 */
export const MODEL_MODALITIES = ["text", "image", "audio", "video", "pdf"] as const;
export type ModelModality = (typeof MODEL_MODALITIES)[number];

/** effort 系思考强度档位全集（模型条目 thinking_levels 子集的合法值域）；off 是通用开关不入子集。 */
export const THINKING_STRENGTH_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingStrengthLevel = (typeof THINKING_STRENGTH_LEVELS)[number];

/**
 * Provider 下的单个模型条目：运行参数与能力位挂在模型上（同厂商不同模型参数各异），
 * Provider 条目本身只承载连接信息（endpoint/key/超时重试/协议级缓存开关）。
 * 能力以输入/输出模态表达（supports_vision 等派生位由投影层从 input_modalities 计算）。
 */
export interface ProviderModelEntry {
  name: string;
  temperature?: number;
  max_completion_tokens?: number;
  max_context_tokens?: number;
  supports_function_calling?: boolean;
  input_modalities?: ModelModality[];
  output_modalities?: ModelModality[];
  /**
   * 模型级思考形状声明（effort / budget / toggle / none）：每条模型必达，无缺省、
   * 无运行时推断（历史格式默认表 / anthropic 折叠 / toggle+子集升级均已退役）。
   * 目录命中模型由 reasoning_options 直出推荐值（用户可改），自定义模型由用户选择。
   * 合法值域受 API 格式能力矩阵约束（anthropic: budget/effort/none；openai 系:
   * effort/toggle/none；gemini: none）——缺失或失配在加载/写入面报错，不静默兜底。
   * 厂商级同名字段已退役（hydration 下沉迁移把厂商值固化进各条目后剥离）。
   */
  thinking_kind?: string;
  /**
   * 模型级思考强度档位子集（目录 reasoning_options 的 effort 值域，如 deepseek 的
   * low/high/max）：存在即替换形状默认档位的强度部分（off 恒可用），agent-llm 运行时
   * 据此校验。空/缺省 = 用形状默认档位。
   */
  thinking_levels?: ThinkingStrengthLevel[];
  /**
   * 思考线字段声明（目录 interleaved.field 推导）：openai 兼容方言下 assistant 消息
   * 承载思考文本的线字段名，仅影响思考模式下的空串补齐（DeepSeek 式"字段必须在场"
   * 怪癖的防御）；解析与回传按厂商原字段 round-trip，不依赖此声明。
   */
  reasoning_field?: "reasoning_content" | "reasoning_details";
}

/** 目录厂商摘要（models.dev api.json 顶层键的投影 + 接入档案推导）。 */
export interface CatalogProviderSummary {
  id: string;
  name: string;
  /** OpenAI 兼容 API base URL；无兼容端点的厂商（openai/anthropic/mistral 等原生或专用 SDK）为 null。 */
  api_base_url: string | null;
  /** 推导的接入 API 格式：npm 官方 SDK 家族映射原生协议（@ai-sdk/openai 等），带兼容端点 → openai_chat；null = 专用 SDK 厂商（bedrock/vertex），内核 4 格式无法直连。 */
  api_format: string | null;
  model_count: number;
}

/** 目录单模型条目（models.dev 模型对象的归一投影，供前端自动填充）。 */
export interface CatalogModelEntry {
  id: string;
  name: string;
  description: string | null;
  input_modalities: ModelModality[];
  output_modalities: ModelModality[];
  context_limit: number | null;
  output_limit: number | null;
  tool_call: boolean | null;
  reasoning: boolean | null;
  /**
   * 目录声明的可接受思考形状集（reasoning_options type → 我方词表 effort/toggle/budget；
   * 空 = 目录无形状信息）。前端与 API 格式能力矩阵取交集后供用户选择。
   */
  accepted_thinking_kinds: string[];
  /** 推荐思考形状（可接受集内的偏好：effort 值域优先，否则跟随厂商风格）；无思考 / 无信息 = null（reasoning:false 时为 "none"）。 */
  recommended_thinking_kind: string | null;
  /** reasoning_options 中 effort 形状的值域（厂商侧档位枚举，过滤到已知强度档位；空 = 未声明）。 */
  reasoning_efforts: string[];
  /** 思考交错（interleaved）标记：思考块与正文交错输出。 */
  interleaved: boolean;
  /** 交错思考的线字段名（reasoning_content / reasoning_details；bool 标记无字段名 → null）。 */
  interleaved_field: string | null;
  /** 官方定价（美元/百万 tokens）；缺省 null。 */
  cost: { input: number | null; output: number | null } | null;
}

export interface CatalogProvidersResult {
  /** false = 目录从未成功拉取（离线首启等），前端隐藏目录填充区。 */
  available: boolean;
  /** true = 目录超过 TTL 但重新校验失败，正在使用过期快照。 */
  stale: boolean;
  providers: CatalogProviderSummary[];
}

export interface CatalogModelsResult {
  available: boolean;
  provider: CatalogProviderSummary;
  models: CatalogModelEntry[];
}

export type ProviderPayload = z.infer<typeof ProviderPayloadSchema>;
export type ReorderProvidersRequest = z.infer<typeof ReorderProvidersRequestSchema>;
export type TestProviderRequest = z.infer<typeof TestProviderRequestSchema>;

export interface ModelProviderConfig {
  name: string;
  /**
   * 厂商 id（provider type 即厂商）：Models.dev 目录厂商 id（openai/zhipuai/moonshotai/alibaba...）
   * 或自定义标识（自建网关等）。自由字符串，由前端目录选择或手填，内核不做封闭校验。
   */
  provider_type: string;
  /**
   * API 格式（协议方言）：openai_resp / openai_chat / anthropic / gemini，
   * kernel 封闭清单（纯协议，无厂商类型）。agent-llm 按此分发；由厂商目录信息推导
   * （官方与兼容网关统一走 openai_chat，官方差异由端点/能力位守卫），思考形状在
   * 模型条目 thinking_kind 上声明（厂商级同名字段已退役）。
   */
  api_format?: string;
  key?: string;
  api_key?: string;
  api_key_configured?: boolean;
  api_endpoint?: string;
  models: ProviderModelEntry[];
  /** Provider connection/first-response and stream idle timeout, in seconds. */
  timeout?: number;
  retry_attempts?: number;
  retry_delay?: number;
  retry_backoff_factor?: number;
  /** Provider prompt cache 总开关；各协议只发送自身支持的缓存字段。 */
  supports_prompt_caching?: boolean;
  /** provider KV cache 有效期(秒);注入上下文快照的 sliding 失效阈值。 */
  cache_ttl_seconds?: number;
  /**
   * 自定义 HTTP 请求头（该 provider 全部 LLM 请求原样附带）：网关侧会话路由/缓存
   * 亲和头（opencode Console Go 的 x-opencode-session、sub2api 的 session_id——
   * 上游 prompt cache 绑定网关侧路由桶，缺稳定会话头会被硬拒或缓存冷启动）或
   * 网关私有标记头。值支持 {session_id} 占位符：agent-llm 调用期解析为该次会话的
   * 稳定路由键（promptCacheKey），无会话上下文的辅助调用（标题/压缩/testProvider）
   * 回落 provider 级稳定值。形态：键 trim 非空、值必须字符串、名字值须 HTTP 头合法
   * （RFC 7230 token / 可打印值，写入面 400、加载面非法条目丢弃）；空表/全非法 → 剥键。
   * 注意：自定义头优先于 SDK 默认头（含 Authorization 鉴权）——接管网关私有鉴权时
   * 有意为之，一般场景勿配置保留头名。
   */
  headers?: Record<string, string>;
  /**
   * 服务端点形态（用户显式声明端点是裸基座还是完整 URL，agent-llm 传输层拼装依据）：
   * - base（缺省，不落盘）：基座 URL，运行时按协议归一拼装规范方法路径（openai 系
   *   /v1/chat/completions|/responses——裸域名自动补 /v1；anthropic /v1/messages）；
   * - full：配置即完整方法 URL 原样直用（接口在根路径、无 /v1 段的网关）。
   * gemini 不适用（URL 由 SDK 按模型名拼装）：写入面 400、加载面剥键。
   */
  endpoint_mode?: "base" | "full";
  is_loaded?: boolean;
  is_available?: boolean;
  [key: string]: unknown;
}

/**
 * Runtime provider catalog exposed to plugins.
 *
 * Provider administration and request execution remain owned by Core's model
 * adapter service; plugins only need this read-only lookup surface.
 */
export interface ModelProviderCatalogPort {
  hasProvider(providerKey: string): boolean;
  getProvider(providerKey: string): ModelProviderConfig | null;
  /** 全部已加载 provider（只读克隆；插件按 key/name 匹配模型用）。 */
  listProviders(): ModelProviderConfig[];
}
