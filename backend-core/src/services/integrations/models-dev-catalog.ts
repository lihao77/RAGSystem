import fs from "node:fs";
import path from "node:path";

import { isRecord } from "../../utils/guards.js";
import {
  MODEL_MODALITIES,
  THINKING_STRENGTH_LEVELS,
  type CatalogModelEntry,
  type CatalogModelsResult,
  type CatalogProviderSummary,
  type CatalogProvidersResult,
  type ModelModality,
} from "../../contracts/integrations/model-adapter.js";

const DEFAULT_BASE_URL = "https://models.dev/api.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
/** 拉取失败后的负缓存窗口：从未成功时避免每次目录请求都阻塞到超时。 */
const DEFAULT_FAILURE_BACKOFF_MS = 60_000;

/** 目录 npm 字段（AI SDK 包名）→ 原生协议家族；@ai-sdk/openai-compatible 等网关包不在此列（走端点推导）。 */
const NATIVE_FORMAT_BY_NPM: Record<string, string> = {
  "@ai-sdk/openai": "openai_chat",
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/google": "gemini",
};

interface RawCatalogProvider {
  id?: unknown;
  name?: unknown;
  api?: unknown;
  npm?: unknown;
  models?: unknown;
}

interface RawCatalogModel {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  modalities?: unknown;
  limit?: unknown;
  tool_call?: unknown;
  reasoning?: unknown;
  reasoning_options?: unknown;
  interleaved?: unknown;
  cost?: unknown;
}

interface DiskCachePayload {
  etag: string | null;
  fetched_at: number;
  api: unknown;
}

export interface ModelsDevCatalogOptions {
  /** dataRoot 已知时在 <dataRoot>/cache/ 落盘快照；缺省（SaaS）纯内存。 */
  dataRoot?: string | undefined;
  /** 目录源地址；缺省读 RAG_MODELS_DEV_URL 环境变量（自建镜像），再退回 models.dev 官方。 */
  baseUrl?: string | undefined;
  /** 出网实现（测试注入）；URL 恒为字符串。 */
  fetchImpl?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
  now?: (() => number) | undefined;
  ttlMs?: number | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Models.dev 模型目录代理：进程级只读元数据源，服务 provider 配置界面的
 * 厂商/模型建议与自动填充。不参与 provider 校验与运行时调用，失败永不抛错——
 * 拉不到就返回 available:false，配置流程退回纯手填。
 *
 * 缓存：内存快照 + <dataRoot>/cache/models-dev-api.json 磁盘快照（含 ETag）。
 * TTL 过期后带 If-None-Match 条件请求，304 只刷新时间戳；网络失败回退旧快照并
 * 置 stale:true，从未成功过则 available:false。并发调用共享同一次校验（单飞）。
 */
export class ModelsDevCatalog {
  private readonly baseUrl: string;
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly cachePath: string | null;

  private memoryLoaded = false;
  private raw: Record<string, RawCatalogProvider> | null = null;
  private summaries: CatalogProviderSummary[] = [];
  private etag: string | null = null;
  private fetchedAt = 0;
  private lastFailureAt = 0;
  private readonly modelMemo = new Map<string, CatalogModelEntry[]>();
  private loadPromise: Promise<void> | null = null;

  constructor(options: ModelsDevCatalogOptions = {}) {
    this.baseUrl =
      options.baseUrl?.trim()
      || process.env.RAG_MODELS_DEV_URL?.trim()
      || DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cachePath = options.dataRoot?.trim()
      ? path.join(path.resolve(options.dataRoot), "cache", "models-dev-api.json")
      : null;
  }

  async listProviders(): Promise<CatalogProvidersResult> {
    await this.ensureData();
    if (!this.raw) {
      return { available: false, stale: false, providers: [] };
    }
    return { available: true, stale: this.isStale(), providers: this.summaries };
  }

  /** 未知厂商 id 返回 null（调用方转 404）；目录不可用时返回 available:false 降级壳。 */
  async listModels(catalogProviderId: string): Promise<CatalogModelsResult | null> {
    await this.ensureData();
    if (!this.raw) {
      return {
        available: false,
        provider: {
          id: catalogProviderId,
          name: catalogProviderId,
          api_base_url: null,
          api_format: null,
          thinking_kind: null,
          model_count: 0,
        },
        models: [],
      };
    }
    const providerRaw = this.raw[catalogProviderId];
    if (!isRecord(providerRaw)) {
      return null;
    }
    return {
      available: true,
      provider: this.providerSummary(catalogProviderId, providerRaw),
      models: this.normalizeProviderModels(catalogProviderId, providerRaw),
    };
  }

  private async ensureData(): Promise<void> {
    if (!this.memoryLoaded) {
      this.hydrateFromDisk();
      this.memoryLoaded = true;
    }
    if (this.raw !== null && this.now() - this.fetchedAt < this.ttlMs) {
      return;
    }
    // 从未成功且仍在失败退避窗口内：直接降级返回，避免离线部署每次目录请求都阻塞到超时
    if (this.raw === null && this.lastFailureAt !== 0 && this.now() - this.lastFailureAt < DEFAULT_FAILURE_BACKOFF_MS) {
      return;
    }
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }
    this.loadPromise = this.revalidate().finally(() => {
      this.loadPromise = null;
    });
    await this.loadPromise;
  }

  /** 失败静默：保留现有快照（若有），过期与否由 isStale() 在读取口表达；从未成功时记录负缓存时间戳。 */
  private async revalidate(): Promise<void> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(this.baseUrl, {
          headers: this.etag ? { "If-None-Match": this.etag } : {},
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 304) {
        this.fetchedAt = this.now();
        this.lastFailureAt = 0;
        this.writeDisk();
        return;
      }
      if (!response.ok) {
        throw new Error(`models.dev 目录请求失败: HTTP ${response.status}`);
      }
      const parsed = JSON.parse(await response.text()) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("models.dev 目录数据格式不符合预期");
      }
      this.applyData(parsed);
      this.etag = response.headers.get("etag");
      this.lastFailureAt = 0;
      this.writeDisk();
    } catch {
      // 离线/超时/坏响应：目录是纯增强，绝不向上抛；从未成功时记退避窗口。
      if (this.raw === null) {
        this.lastFailureAt = this.now();
      }
    }
  }

  private applyData(parsed: Record<string, unknown>): void {
    const providers: Record<string, RawCatalogProvider> = {};
    const summaries: CatalogProviderSummary[] = [];
    for (const [id, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      const providerRaw = value as RawCatalogProvider;
      providers[id] = providerRaw;
      summaries.push(this.providerSummary(id, providerRaw));
    }
    summaries.sort((a, b) => a.name.localeCompare(b.name));
    this.raw = providers;
    this.summaries = summaries;
    this.fetchedAt = this.now();
    this.modelMemo.clear();
  }

  /**
   * 厂商摘要 + 接入档案推导（provider 表单默认值，用户可改）：API 格式来自
   * npm SDK 家族或兼容端点；思考形状来自模型 reasoning_options 投票。
   */
  private providerSummary(id: string, providerRaw: RawCatalogProvider): CatalogProviderSummary {
    const models: Record<string, unknown> = isRecord(providerRaw.models) ? providerRaw.models : {};
    const apiBaseUrl = asApiBaseUrl(providerRaw.api);
    const apiFormat = deriveApiFormat(providerRaw, apiBaseUrl);
    return {
      id,
      name: String(providerRaw.name ?? "") || id,
      api_base_url: apiBaseUrl,
      api_format: apiFormat,
      thinking_kind: deriveThinkingKind(apiFormat, models),
      model_count: Object.keys(models).length,
    };
  }

  private normalizeProviderModels(catalogProviderId: string, providerRaw: RawCatalogProvider): CatalogModelEntry[] {
    const memoized = this.modelMemo.get(catalogProviderId);
    if (memoized) {
      return memoized;
    }
    const models: CatalogModelEntry[] = [];
    if (isRecord(providerRaw.models)) {
      for (const value of Object.values(providerRaw.models)) {
        if (!isRecord(value)) {
          continue;
        }
        const entry = normalizeCatalogModel(value as RawCatalogModel);
        if (entry) {
          models.push(entry);
        }
      }
    }
    this.modelMemo.set(catalogProviderId, models);
    return models;
  }

  private isStale(): boolean {
    return this.raw !== null && this.now() - this.fetchedAt >= this.ttlMs;
  }

  private hydrateFromDisk(): void {
    if (!this.cachePath) {
      return;
    }
    try {
      if (!fs.existsSync(this.cachePath)) {
        return;
      }
      const payload = JSON.parse(fs.readFileSync(this.cachePath, "utf8")) as unknown;
      if (!isRecord(payload) || !isRecord(payload.api) || typeof payload.fetched_at !== "number") {
        return;
      }
      this.applyData(payload.api);
      this.etag = typeof payload.etag === "string" ? payload.etag : null;
      this.fetchedAt = payload.fetched_at;
    } catch {
      // 磁盘快照损坏视同无缓存，走网络。
    }
  }

  private writeDisk(): void {
    if (!this.cachePath || this.raw === null) {
      return;
    }
    try {
      const payload: DiskCachePayload = { etag: this.etag, fetched_at: this.fetchedAt, api: this.raw };
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(payload), "utf8");
    } catch {
      // 磁盘缓存写失败不影响内存目录。
    }
  }
}

function normalizeCatalogModel(raw: RawCatalogModel): CatalogModelEntry | null {
  const id = String(raw.id ?? "").trim();
  if (!id) {
    return null;
  }
  const modalities = isRecord(raw.modalities) ? raw.modalities : {};
  const limit = isRecord(raw.limit) ? raw.limit : {};
  const cost = isRecord(raw.cost) ? raw.cost : null;
  return {
    id,
    name: String(raw.name ?? "") || id,
    description: raw.description === undefined || raw.description === null ? null : String(raw.description),
    input_modalities: normalizeModalities(modalities.input),
    output_modalities: normalizeModalities(modalities.output),
    context_limit: asPositiveInt(limit.context),
    output_limit: asPositiveInt(limit.output),
    tool_call: typeof raw.tool_call === "boolean" ? raw.tool_call : null,
    reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : null,
    reasoning_efforts: collectReasoningEfforts(raw.reasoning_options),
    interleaved: raw.interleaved === true || isRecord(raw.interleaved),
    interleaved_field: asInterleavedField(raw.interleaved),
    cost: cost ? { input: asNonNegativeNumber(cost.input), output: asNonNegativeNumber(cost.output) } : null,
  };
}

/**
 * reasoning_options 中 effort 形状的值域并集（目录厂商枚举，如 deepseek 的
 * low/high/max）：过滤到已知强度档位并按全集顺序输出；空 = 模型未声明 effort 档位。
 */
function collectReasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const known = new Set<string>(THINKING_STRENGTH_LEVELS);
  const picked = new Set<string>();
  for (const option of value) {
    if (!isRecord(option) || option.type !== "effort" || !Array.isArray(option.values)) {
      continue;
    }
    for (const item of option.values) {
      const token = String(item ?? "").trim().toLowerCase();
      if (known.has(token)) {
        picked.add(token);
      }
    }
  }
  return THINKING_STRENGTH_LEVELS.filter((level) => picked.has(level));
}

/**
 * API 格式推导：npm 官方 SDK 家族 → 原生协议；带 OpenAI 兼容端点（api 字段，
 * models.dev 只在厂商兼容时提供）→ openai_chat；两者皆无（mistral/bedrock 等
 * 专用 SDK 厂商）→ null，内核 5 格式无法直连，不进建议列表。
 */
function deriveApiFormat(providerRaw: RawCatalogProvider, apiBaseUrl: string | null): string | null {
  const npm = typeof providerRaw.npm === "string" ? providerRaw.npm.trim() : "";
  const nativeFormat = NATIVE_FORMAT_BY_NPM[npm];
  return nativeFormat ?? (apiBaseUrl ? "openai_chat" : null);
}

/**
 * 思考形状推导：对厂商全部模型的 reasoning_options 投票——「有 toggle 无 effort」
 * 的模型多于「有 effort 无 toggle」→ 声明 toggle（qwen 系启停开关型）；effort/budget
 * 形状即格式默认值，不显式声明。toggle+effort 同模型（deepseek）不计票 → effort
 * 默认，与其顶层 reasoning_effort 的实测用法一致。非思考参数格式恒 null。
 */
function deriveThinkingKind(apiFormat: string | null, modelsRaw: Record<string, unknown>): string | null {
  if (apiFormat !== "openai_chat" && apiFormat !== "openai_resp" && apiFormat !== "anthropic") {
    return null;
  }
  let toggleOnly = 0;
  let effortOnly = 0;
  for (const value of Object.values(modelsRaw)) {
    if (!isRecord(value) || !Array.isArray(value.reasoning_options)) {
      continue;
    }
    const types = new Set<string>();
    for (const option of value.reasoning_options) {
      if (isRecord(option) && typeof option.type === "string") {
        types.add(option.type);
      }
    }
    if (types.has("toggle") && !types.has("effort")) {
      toggleOnly += 1;
    } else if (types.has("effort") && !types.has("toggle")) {
      effortOnly += 1;
    }
  }
  return toggleOnly > effortOnly ? "toggle" : null;
}

function normalizeModalities(value: unknown): ModelModality[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const known = new Set<string>(MODEL_MODALITIES);
  const result: ModelModality[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const token = String(item ?? "").trim().toLowerCase();
    if (!token || !known.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    result.push(token as ModelModality);
  }
  return result;
}

function asApiBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** interleaved 的线字段名（openrouter 部分模型为 reasoning_details）；bool 标记/未知值 → null。 */
function asInterleavedField(value: unknown): string | null {
  if (!isRecord(value) || typeof value.field !== "string") {
    return null;
  }
  const field = value.field.trim();
  return field === "reasoning_content" || field === "reasoning_details" ? field : null;
}

function asPositiveInt(value: unknown): number | null {
  const n = asNonNegativeNumber(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}
