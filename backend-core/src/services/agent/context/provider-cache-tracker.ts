/**
 * ProviderCacheTracker —— provider KV cache 活性追踪(sliding expiration),按 threadKey 分桶。
 *
 * 为什么按 threadKey 而非 session:provider cache 按请求前缀字节缓存,不按 session。同一 session 内
 * parent(root thread)与 child delegation(child:<id> thread)用不同 system prompt + tools → 不同前缀
 * → provider 端是两个独立 cache。若 session 级共享 last_used_at,parent 的 touch 会让 child 误判 cache
 * 活(反之亦然)。按 threadKey 分桶,各 thread 各自的 cache 活性互不干扰。
 *
 * 封装 last_used_at 的 session metadata 读写(`_provider_cache[threadKey].last_used_at`),提供
 * isAlive/touch/invalidate。所有“是否据 cache 活性决定更新”的子系统（插件前缀、未来其它）
 * 经 buildContext 的 request.cacheAlive 信号接入,与本 tracker 解耦——source 不自管时间戳。
 *
 * 活性判断对齐 provider 的 sliding KV cache(如 Anthropic 默认 5min:持续命中续期、闲置超 TTL 失效)。
 * 续期(touch)只在真正发请求的 run 路径调(buildContext options.touch);只读 build(preview / token
 * 预算)不续期,避免 GET 等只读路径产生写副作用。
 */
import type { SessionMetadataPort } from "./types.js";
import { DEFAULT_THREAD_KEY } from "./types.js";

/** provider KV cache 默认有效期(秒):对齐 Anthropic prompt cache 默认 5 分钟 sliding TTL。 */
export const DEFAULT_PROVIDER_CACHE_TTL_SECONDS = 300;

function normalizeThreadKey(threadKey: string): string {
  return threadKey.trim() || DEFAULT_THREAD_KEY;
}

function readLastUsedAt(metadata: Record<string, unknown>, normalizedThreadKey: string): number | null {
  const cache = metadata._provider_cache;
  if (cache !== null && typeof cache === "object" && !Array.isArray(cache)) {
    const entry = (cache as Record<string, unknown>)[normalizedThreadKey];
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const value = (entry as Record<string, unknown>).last_used_at;
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

export class ProviderCacheTracker {
  constructor(
    private readonly sessions: SessionMetadataPort,
    private readonly ttlSeconds: number,
  ) {}

  /** cache 是否还活:有上次记录且未超 ttlSeconds。null/超时 → false(视为失效,触发各 source 更新)。 */
  isAlive(sessionId: string, threadKey: string, now: number): boolean {
    const metadata = this.sessions.getSession(sessionId)?.metadata ?? {};
    const last = readLastUsedAt(metadata, normalizeThreadKey(threadKey));
    return last !== null && now - last <= this.ttlSeconds;
  }

  /** 续期(滑动):写 last_used_at = now。只在 run 路径(buildContext options.touch=true)调。 */
  touch(sessionId: string, threadKey: string, now: number): void {
    const key = normalizeThreadKey(threadKey);
    this.sessions.updateSessionMetadata?.(sessionId, { _provider_cache: { [key]: { last_used_at: now } } });
  }

  /** 失效:清空本 threadKey 的 last_used_at(如压缩打断 cache 后,让下次 isAlive 返回 false)。不碰其它 threadKey。 */
  invalidate(sessionId: string, threadKey: string): void {
    const key = normalizeThreadKey(threadKey);
    this.sessions.updateSessionMetadata?.(sessionId, { _provider_cache: { [key]: null } });
  }
}
