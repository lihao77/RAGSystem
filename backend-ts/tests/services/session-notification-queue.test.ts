import { describe, it, expect } from "vitest";
import { SessionNotificationQueue } from "../../src/services/runtime/session-notification-queue.js";

function payload(taskId: string, status = "completed") {
  return {
    task_id: taskId,
    background_task_id: taskId,
    status,
    return_code: 0,
    output_path: `/tmp/${taskId}.log`,
  };
}

describe("SessionNotificationQueue", () => {
  it("add 后 drain 取出全部并清空，peek 反映非空/空", () => {
    const queue = new SessionNotificationQueue();
    expect(queue.peek("s1")).toBe(false);
    queue.add("s1", payload("t1"));
    queue.add("s1", payload("t2"));
    expect(queue.peek("s1")).toBe(true);
    const drained = queue.drain("s1");
    expect(drained.map((p) => p.task_id)).toEqual(["t1", "t2"]);
    expect(queue.peek("s1")).toBe(false);
  });

  it("drain 互斥：第二次 drain 返回空（通道 A/B 共享队列、互斥消费）", () => {
    const queue = new SessionNotificationQueue();
    queue.add("s1", payload("t1"));
    expect(queue.drain("s1")).toHaveLength(1);
    expect(queue.drain("s1")).toEqual([]);
  });

  it("drain exclude 保留指定 taskId，再次 drain 取出（预留给通道 B waiting-loop 去重）", () => {
    const queue = new SessionNotificationQueue();
    queue.add("s1", payload("t1"));
    queue.add("s1", payload("t2"));
    const first = queue.drain("s1", new Set(["t1"]));
    expect(first.map((p) => p.task_id)).toEqual(["t2"]);
    expect(queue.peek("s1")).toBe(true);
    const second = queue.drain("s1");
    expect(second.map((p) => p.task_id)).toEqual(["t1"]);
  });

  it("markConsumed 从 pending 移除该 task，drain 不返回", () => {
    const queue = new SessionNotificationQueue();
    queue.add("s1", payload("t1"));
    queue.add("s1", payload("t2"));
    queue.markConsumed("s1", "t1");
    const drained = queue.drain("s1");
    expect(drained.map((p) => p.task_id)).toEqual(["t2"]);
  });

  it("consumed 去重：markConsumed 后再 add 同 taskId 不入队（waiting loop 已即时处理的不再投递）", () => {
    const queue = new SessionNotificationQueue();
    queue.markConsumed("s1", "t1");
    queue.add("s1", payload("t1"));
    expect(queue.peek("s1")).toBe(false);
    expect(queue.drain("s1")).toEqual([]);
  });

  it("各 session 队列相互独立", () => {
    const queue = new SessionNotificationQueue();
    queue.add("s1", payload("t1"));
    queue.add("s2", payload("t2"));
    expect(queue.drain("s1").map((p) => p.task_id)).toEqual(["t1"]);
    expect(queue.drain("s2").map((p) => p.task_id)).toEqual(["t2"]);
  });
});
