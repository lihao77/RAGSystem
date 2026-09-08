/**
 * Provider 自定义请求头解析（ProviderConfig.headers → 每请求头表）。
 *
 * 两类消费场景共用一条通道：网关会话路由/缓存亲和头（opencode Console Go 的
 * x-opencode-session、sub2api 的 session_id——上游 prompt cache 绑定网关侧
 * 路由桶，缺稳定会话头轻则缓存冷启动、重则网关硬拒 400）与网关私有静态头。
 * 会话值不直接暴露内部 ID：占位符解析的是调用方已派生的稳定路由键
 * （LlmRequest.promptCacheKey，见 agent-sdk buildPromptCacheKey）。
 */
import { createHash } from "node:crypto";
import type { ProviderConfig } from "./types.js";

/** 头值内的会话占位符：调用期替换为该次会话的稳定路由键（全局替换）。 */
export const SESSION_ID_PLACEHOLDER = "{session_id}";

/** RFC 7230 token（合法 header 名）；空串/含空格、CRLF 等控制字符的名字在 fetch 构造期抛错。 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** 合法 header 值：可打印 ASCII + tab + latin1 扩展（undici ByteString 限制，拒 CR/LF/NUL）。 */
export function isValidHeaderValue(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || (code >= 0x20 && code <= 0x7e) || code >= 0x80 && code <= 0xff) continue;
    return false;
  }
  return true;
}

export function isValidHeaderName(name: string): boolean {
  return HEADER_NAME_PATTERN.test(name);
}

/**
 * 解析 provider.headers 为本次请求的头表；无有效条目返回 undefined（适配器跳过注入，
 * 零配置零开销）。占位符解析：有 promptCacheKey 用之（会话内所有请求同值、跨会话不同
 * 值）；无键的辅助调用（标题生成/压缩/testProvider 等不经 agent-sdk 协议的调用点）
 * 回落 provider 级稳定值，保证占位符头恒在场——硬性网关缺头即 400。
 */
export function resolveProviderHeaders(
  provider: ProviderConfig,
  promptCacheKey: string | null | undefined,
): Record<string, string> | undefined {
  const raw = provider.headers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const sessionId = promptCacheKey?.trim() || auxSessionId(provider);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const headerName = name.trim();
    // 键空白/值非字符串/名字值含非法字符的条目丢弃：配置层归一已保证形状，这里是
    // 传输层的防御性二道闸（防手工编辑半迁移态在 fetch 构造期抛错）。
    if (!headerName || typeof value !== "string") continue;
    if (!isValidHeaderName(headerName) || !isValidHeaderValue(value)) continue;
    headers[headerName] = value.split(SESSION_ID_PLACEHOLDER).join(sessionId);
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * 辅助调用回落键：provider 标识非头值安全字符（如中文 name）时折叠为哈希摘要——
 * 保持稳定与可区分，同时保证 latin1 合法（undici ByteString 硬约束）。
 */
function auxSessionId(provider: ProviderConfig): string {
  const identity = provider.key ?? provider.name ?? "provider";
  if (isValidHeaderValue(identity)) return `ragsystem:aux:${identity}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `ragsystem:aux:${digest}`;
}
