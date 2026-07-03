import { describe, it, expect } from "vitest";
import { ProviderCacheTracker } from "../../src/services/agent/context/provider-cache-tracker.js";
import type { SessionMetadataPort } from "../../src/services/agent/context/types.js";

/** 模拟真实 deepMergeRecords:递归合并 record,null 覆盖(不递归)。 */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      out[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** in-memory SessionMetadataPort fake,用真实 deepMerge 语义(嵌套合并 + null 覆盖)。 */
function makeFakeStore(): SessionMetadataPort {
  let meta: Record<string, unknown> = {};
  return {
    getSession: () => ({ metadata: meta }),
    updateSessionMetadata: (_sid: string, patch: Record<string, unknown>) => {
      meta = deepMerge(meta, patch);
      return meta;
    },
  };
}

describe("ProviderCacheTracker", () => {
  it("首次 isAlive=false(无 last_used_at)", () => {
    const tracker = new ProviderCacheTracker(makeFakeStore(), 300);
    expect(tracker.isAlive("s1", "root", 1000)).toBe(false);
  });

  it("touch 后未超 TTL → isAlive=true", () => {
    const tracker = new ProviderCacheTracker(makeFakeStore(), 300);
    tracker.touch("s1", "root", 1000);
    expect(tracker.isAlive("s1", "root", 1100)).toBe(true);
  });

  it("超 TTL → isAlive=false(边界:恰好 TTL 仍活,超 1 秒死)", () => {
    const tracker = new ProviderCacheTracker(makeFakeStore(), 300);
    tracker.touch("s1", "root", 1000);
    expect(tracker.isAlive("s1", "root", 1300)).toBe(true); // 1300-1000=300 ≤ 300
    expect(tracker.isAlive("s1", "root", 1301)).toBe(false); // 301 > 300
  });

  it("touch 滑动续期(再次 touch 重置 TTL 起点)", () => {
    const tracker = new ProviderCacheTracker(makeFakeStore(), 300);
    tracker.touch("s1", "root", 1000);
    expect(tracker.isAlive("s1", "root", 1200)).toBe(true); // 200 ≤ 300
    tracker.touch("s1", "root", 1200); // 续期,新起点 1200
    expect(tracker.isAlive("s1", "root", 1500)).toBe(true); // 1500-1200=300 ≤ 300
    expect(tracker.isAlive("s1", "root", 1501)).toBe(false); // 301 > 300
  });

  it("invalidate 后 isAlive=false", () => {
    const tracker = new ProviderCacheTracker(makeFakeStore(), 300);
    tracker.touch("s1", "root", 1000);
    tracker.invalidate("s1", "root");
    expect(tracker.isAlive("s1", "root", 1100)).toBe(false);
  });

  it("parent/child 隔离:touch root 不让 child 误判活(provider cache 按前缀,parent/child 独立)", () => {
    const tracker = new ProviderCacheTracker(makeFakeStore(), 300);
    tracker.touch("s1", "root", 1000);
    expect(tracker.isAlive("s1", "root", 1100)).toBe(true);
    expect(tracker.isAlive("s1", "child:42", 1100)).toBe(false); // child 没碰过
  });

  it("invalidate root 不影响 child(压缩 parent 不打掉 child 的 cache 活性)", () => {
    const tracker = new ProviderCacheTracker(makeFakeStore(), 300);
    tracker.touch("s1", "root", 1000);
    tracker.touch("s1", "child:42", 1000);
    tracker.invalidate("s1", "root");
    expect(tracker.isAlive("s1", "root", 1100)).toBe(false);
    expect(tracker.isAlive("s1", "child:42", 1100)).toBe(true); // child 不受影响
  });

  it("threadKey 未 trim 经 normalize 归一(与 buildContext / memoryBaselineKey 对齐)", () => {
    const tracker = new ProviderCacheTracker(makeFakeStore(), 300);
    tracker.touch("s1", "  root  ", 1000); // 未 trim
    expect(tracker.isAlive("s1", "root", 1100)).toBe(true); // 归一到 root
    expect(tracker.isAlive("s1", "", 1100)).toBe(true); // 空串 → DEFAULT_THREAD_KEY="root"
  });
});
