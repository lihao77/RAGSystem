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
    warnCatalogDrift(collectCatalogDrift(parsed));
  }

  /**
   * 厂商摘要 + 接入档案推导（provider 表单默认值，用户可改）：API 格式来自
   * npm SDK 家族或兼容端点；思考形状已下沉到每模型条目（推荐值/可接受集），
   * 厂商级不再投票。
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
    accepted_thinking_kinds: collectAcceptedThinkingKinds(raw.reasoning_options),
    recommended_thinking_kind: deriveRecommendedThinkingKind(raw),
    reasoning_efforts: collectReasoningEfforts(raw.reasoning_options),
    interleaved: raw.interleaved === true || isRecord(raw.interleaved),
    interleaved_field: asInterleavedField(raw.interleaved),
    cost: cost ? { input: asNonNegativeNumber(cost.input), output: asNonNegativeNumber(cost.output) } : null,
  };
}

/**
 * 目录 reasoning_options.type → 我方思考形状词表（单一事实源：可接受集收集与
 * 漂移对账共用；目录新增 type 时此处未登记即触发 warnCatalogDrift 告警）。
 * 收集产物交前端与 API 格式能力矩阵取交集后供用户选择；空 = 目录无形状信息。
 */
const THINKING_KIND_BY_OPTION_TYPE: Readonly<Record<string, string>> = {
  effort: "effort",
  toggle: "toggle",
  budget_tokens: "budget",
};

function collectAcceptedThinkingKinds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const kinds = new Set<string>();
  for (const option of value) {
    if (!isRecord(option) || typeof option.type !== "string") {
      continue;
    }
    const kind = THINKING_KIND_BY_OPTION_TYPE[option.type.trim().toLowerCase()];
    if (kind) kinds.add(kind);
  }
  return ["effort", "toggle", "budget"].filter((kind) => kinds.has(kind));
}

/**
 * 每模型推荐思考形状（预填默认，用户可改）：effort 值域优先（分级最细），
 * 否则跟随厂商风格（toggle → budget），无思考 → "none"，无形状信息 → null。
 */
function deriveRecommendedThinkingKind(raw: RawCatalogModel): string | null {
  if (raw.reasoning === false) {
    return "none";
  }
  const accepted = collectAcceptedThinkingKinds(raw.reasoning_options);
  if (accepted.includes("effort")) return "effort";
  if (accepted.includes("toggle")) return "toggle";
  if (accepted.includes("budget")) return "budget";
  return null;
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

// ────────────────────────────── 词表对账 ──────────────────────────────

interface CatalogDriftReport {
  /** 词表外 reasoning_options.type → 出现次数（当前静默丢弃）。 */
  unknownOptionTypes: Map<string, number>;
  /** 词表外 effort 档位 → 出现次数（collectReasoningEfforts 值域过滤丢弃）。 */
  unknownEffortLevels: Map<string, number>;
}

/** 全目录漂移扫描：applyData 每次成功同步调用一次（与 listModels 的按需 memo 无关）。 */
function collectCatalogDrift(parsed: Record<string, unknown>): CatalogDriftReport {
  const report: CatalogDriftReport = { unknownOptionTypes: new Map(), unknownEffortLevels: new Map() };
  for (const provider of Object.values(parsed)) {
    if (!isRecord(provider) || !isRecord(provider.models)) {
      continue;
    }
    for (const model of Object.values(provider.models)) {
      if (!isRecord(model) || !Array.isArray(model.reasoning_options)) {
        continue;
      }
      for (const option of model.reasoning_options) {
        if (!isRecord(option) || typeof option.type !== "string") {
          continue;
        }
        const type = option.type.trim().toLowerCase();
        if (type && !(type in THINKING_KIND_BY_OPTION_TYPE)) {
          bump(report.unknownOptionTypes, type);
        }
        if (type === "effort" && Array.isArray(option.values)) {
          for (const item of option.values) {
            const level = String(item ?? "").trim().toLowerCase();
            if (level && !(THINKING_STRENGTH_LEVELS as readonly string[]).includes(level)) {
              bump(report.unknownEffortLevels, level);
            }
          }
        }
      }
    }
  }
  return report;
}

/**
 * 目录词表漂移告警：models.dev 出现我方词表外的思考选项时当前只会静默丢弃，
 * 目录侧演进（如当年新增 budget_tokens type）不会自察。每次同步汇总一次
 * console.warn 提示对齐词表；纯观测，不阻断目录服务。
 */
function warnCatalogDrift(report: CatalogDriftReport): void {
  if (report.unknownOptionTypes.size === 0 && report.unknownEffortLevels.size === 0) return;
  const parts: string[] = [];
  if (report.unknownOptionTypes.size > 0) {
    parts.push(`type: ${formatDriftEntries(report.unknownOptionTypes)}`);
  }
  if (report.unknownEffortLevels.size > 0) {
    parts.push(`effort 档位: ${formatDriftEntries(report.unknownEffortLevels)}`);
  }
  console.warn(
    `[models-dev-catalog] 目录出现词表外思考选项（当前静默丢弃）：${parts.join("；")}`
    + " —— 请对齐 THINKING_KIND_BY_OPTION_TYPE / THINKING_STRENGTH_LEVELS 词表",
  );
}

function formatDriftEntries(entries: Map<string, number>): string {
  return [...entries.entries()].map(([token, count]) => `${token}×${count}`).join(", ");
}

function bump(target: Map<string, number>, token: string): void {
  target.set(token, (target.get(token) ?? 0) + 1);
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
