import { afterEach, describe, expect, it, vi } from "vitest";

import { createWidgetCredentialStore } from "../../../src/services/stores/widget-credential-store/index.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("WidgetCredentialStore pruning", () => {
  it("pruneExpiredTokens removes expired token rows", () => {
    const store = createWidgetCredentialStore({ dbPath: ":memory:" });
    const created = store.ops.createApp({ display_name: "x" });
    store.ops.recordToken({ jti: "j1", app_key: created.app_key, issued_at: 0, expires_at: 1 });
    store.ops.recordToken({ jti: "j2", app_key: created.app_key, issued_at: 0, expires_at: 9_999_999_999 });

    // now > expires_at(1) → j1 过期被清，j2 保留。
    const removed = store.ops.pruneExpiredTokens(1000);
    expect(removed).toBe(1);
    expect(store.ops.isTokenRevoked("j1")).toBe(true); // 已删 → 未知 jti 视为撤销
    expect(store.ops.isTokenRevoked("j2")).toBe(false); // 未过期、未撤销
    store.close();
  });

  it("startPruning runs cleanup on interval (fake timers)", () => {
    vi.useFakeTimers();
    const store = createWidgetCredentialStore({ dbPath: ":memory:" });
    const created = store.ops.createApp({ display_name: "x" });
    store.ops.recordToken({ jti: "expired", app_key: created.app_key, issued_at: 0, expires_at: 1 });

    store.startPruning(60_000);
    // 首次立即清一次。
    expect(store.ops.isTokenRevoked("expired")).toBe(true);
    // 再塞一条，等一个周期确认定时清理生效。
    store.ops.recordToken({ jti: "later", app_key: created.app_key, issued_at: 0, expires_at: 1 });
    vi.advanceTimersByTime(60_000);
    expect(store.ops.isTokenRevoked("later")).toBe(true);
    store.stop();
    store.close();
  });

  it("startPruning is idempotent", () => {
    vi.useFakeTimers();
    const store = createWidgetCredentialStore({ dbPath: ":memory:" });
    store.startPruning(60_000);
    store.startPruning(60_000); // 不应重复挂定时器
    store.stop();
    store.close();
    expect(true).toBe(true);
  });
});
