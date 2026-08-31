import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";

import { AttemptGuard } from "../dist/transport.js";

test("AttemptGuard dispose 后解除对父 signal 的 abort 监听", () => {
  const parent = new AbortController();
  const guard = new AttemptGuard(parent.signal, 1_000);
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);

  guard.dispose();
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);

  // 解除后父 signal 触发不再传导（请求已结束，guard 随之可回收）
  parent.abort();
  assert.equal(guard.aborted, false);
});

test("AttemptGuard 未 dispose 前父 signal 中止仍传导", () => {
  const parent = new AbortController();
  const guard = new AttemptGuard(parent.signal, 1_000);
  const reason = new Error("session cancelled");
  parent.abort(reason);
  assert.equal(guard.aborted, true);
  assert.equal(guard.signal.reason, reason);
  guard.dispose();
});

test("AttemptGuard 构造时父 signal 已中止则直接传导且不挂监听器", () => {
  const parent = new AbortController();
  const reason = new Error("already cancelled");
  parent.abort(reason);
  const guard = new AttemptGuard(parent.signal, 1_000);
  assert.equal(guard.aborted, true);
  assert.equal(guard.signal.reason, reason);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  guard.dispose();
});
