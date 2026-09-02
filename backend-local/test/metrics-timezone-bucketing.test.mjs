import assert from "node:assert/strict";
import test from "node:test";

import { createConversationStore } from "../dist/adapters/local/sqlite/conversation-store/index.js";

/**
 * 日/小时/星期分桶必须按目标时区墙钟切，而不是存储列的 UTC 文本。
 * 夹具选跨日界样本：2026-09-02T17:30Z 在上海已是 09-03 凌晨 01:30（周四），在 UTC 仍是 09-02 下午（周三）。
 */
const METRIC_A = "2026-09-02T17:30:00.000Z"; // 上海: 2026-09-03 周四 01:30 / UTC: 2026-09-02 周三 17:30
const METRIC_B = "2026-09-02T10:00:00.000Z"; // 上海: 2026-09-02 周三 18:00 / UTC: 2026-09-02 周三 10:00

function seedMetrics(store) {
  for (const [startedAt, tokens] of [[METRIC_A, 100], [METRIC_B, 50]]) {
    store.insertMetric({
      agentName: "assistant",
      executionKind: "agent_stream",
      status: "completed",
      durationMs: 1000,
      tokenIn: tokens,
      tokenOut: tokens / 2,
      startedAt,
    });
  }
}

test("daily activity buckets by the target timezone's wall clock", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    seedMetrics(store);
    assert.deepEqual(
      store.aggregateDailyActivity({ timeZone: "Asia/Shanghai" }),
      [{ date: "2026-09-02", calls: 1 }, { date: "2026-09-03", calls: 1 }],
    );
    assert.deepEqual(
      store.aggregateDailyActivity({ timeZone: "UTC" }),
      [{ date: "2026-09-02", calls: 2 }],
    );
  } finally {
    store.close();
  }
});

test("token trend hour/day keys follow the target timezone", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    seedMetrics(store);
    const shanghaiHours = store.aggregateTokenTrend({ bucket: "hour", timeZone: "Asia/Shanghai" });
    assert.deepEqual(shanghaiHours.map((point) => point.ts), ["2026-09-02T18:00", "2026-09-03T01:00"]);
    assert.equal(shanghaiHours[0].token_in, 50);
    assert.equal(shanghaiHours[1].token_in, 100);

    const utcDays = store.aggregateTokenTrend({ bucket: "day", timeZone: "UTC" });
    assert.deepEqual(utcDays, [{ ts: "2026-09-02", token_in: 150, token_out: 75, calls: 2 }]);
  } finally {
    store.close();
  }
});

test("activity heatmap weekday(0=周日) and hour follow the target timezone", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    seedMetrics(store);
    assert.deepEqual(
      store.aggregateActivityHeatmap({ timeZone: "Asia/Shanghai" }),
      [{ weekday: 3, hour: 18, calls: 1 }, { weekday: 4, hour: 1, calls: 1 }],
    );
    assert.deepEqual(
      store.aggregateActivityHeatmap({ timeZone: "UTC" }),
      [{ weekday: 3, hour: 10, calls: 1 }, { weekday: 3, hour: 17, calls: 1 }],
    );
  } finally {
    store.close();
  }
});

test("since filter still applies before bucketing", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    seedMetrics(store);
    assert.deepEqual(
      store.aggregateDailyActivity({ since: "2026-09-02T12:00:00.000Z", timeZone: "Asia/Shanghai" }),
      [{ date: "2026-09-03", calls: 1 }],
    );
  } finally {
    store.close();
  }
});

test("model usage aggregation is timezone-independent and ordered by tokens", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    store.insertMetric({ agentName: "a", executionKind: "agent_stream", status: "completed", durationMs: 1, tokenIn: 10, startedAt: METRIC_A, model: "m1" });
    store.insertMetric({ agentName: "b", executionKind: "agent_stream", status: "completed", durationMs: 1, tokenIn: 500, startedAt: METRIC_B, model: "m2" });
    assert.deepEqual(
      store.aggregateModelUsage({}),
      [{ model: "m2", tokens: 500, calls: 1 }, { model: "m1", tokens: 10, calls: 1 }],
    );
  } finally {
    store.close();
  }
});

test("midnight lands in the 00 hour bucket, never 24", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    // 上海午夜 = UTC 前一天 16:00；hourCycle h23 下必须是 "00" 桶。
    store.insertMetric({ agentName: "a", executionKind: "agent_stream", status: "completed", durationMs: 1, startedAt: "2026-09-02T16:00:00.000Z" });
    assert.deepEqual(
      store.aggregateTokenTrend({ bucket: "hour", timeZone: "Asia/Shanghai" }),
      [{ ts: "2026-09-03T00:00", token_in: 0, token_out: 0, calls: 1 }],
    );
    assert.deepEqual(
      store.aggregateActivityHeatmap({ timeZone: "Asia/Shanghai" }),
      [{ weekday: 4, hour: 0, calls: 1 }],
    );
  } finally {
    store.close();
  }
});

test("DST transitions bucket by the wall clock of the target zone", () => {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  try {
    // 美东 2026-03-08 春令时：02:00 被跳过，07:00Z 即当天 03:00 EDT。
    // 美东 2026-11-01 秋令时：01:00 出现两次，06:30Z 落在第二次（EST 01:30）。
    store.insertMetric({ agentName: "a", executionKind: "agent_stream", status: "completed", durationMs: 1, startedAt: "2026-03-08T07:00:00.000Z" });
    store.insertMetric({ agentName: "a", executionKind: "agent_stream", status: "completed", durationMs: 1, startedAt: "2026-11-01T06:30:00.000Z" });
    assert.deepEqual(
      store.aggregateTokenTrend({ bucket: "hour", timeZone: "America/New_York" }).map((point) => point.ts),
      ["2026-03-08T03:00", "2026-11-01T01:00"],
    );
  } finally {
    store.close();
  }
});
