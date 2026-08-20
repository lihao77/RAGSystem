import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify from "fastify";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";

import { createPetPlugin, mapToolToAnimation, PetActivityTracker, registerPetAssetRoutes } from "../dist/index.js";

const EMPTY_SNAPSHOT = { activeRuns: 0, lastErrorAt: null, lastCompletedAt: null, lastSummary: null, busyHint: null };

test("工具名 → 动画映射按子串命中", () => {
  assert.equal(mapToolToAnimation("run_bash_command"), "原地敲击桌面互动");
  assert.equal(mapToolToAnimation("write_file"), "轻快记录");
  assert.equal(mapToolToAnimation("web_search"), "深度思考碎碎念");
  assert.equal(mapToolToAnimation("knowledge_query"), "照镜子");
  assert.equal(mapToolToAnimation("完全无关"), null);
});

test("PetActivityTracker 经 run 钩子维护活跃计数与终态摘要，并在变更时通知订阅者", () => {
  const handlers = new Map();
  const tracker = new PetActivityTracker();
  tracker.install({
    on: (event, handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  });

  assert.deepEqual(tracker.snapshot(), EMPTY_SNAPSHOT);

  const notifications = [];
  const unsubscribe = tracker.onChange((snapshot) => notifications.push(snapshot));

  handlers.get("run.before")({});
  handlers.get("run.before")({});
  assert.equal(tracker.snapshot().activeRuns, 2);
  assert.equal(notifications.length, 2);
  assert.equal(notifications.at(-1).activeRuns, 2);

  handlers.get("run.finally")({ status: "completed", result: { content: "  任务完成\n\n 详细内容 ".repeat(20) } });
  const afterComplete = tracker.snapshot();
  assert.equal(afterComplete.activeRuns, 1);
  assert.equal(typeof afterComplete.lastCompletedAt, "number");
  assert.ok(afterComplete.lastSummary.startsWith("任务完成 详细内容"));
  assert.ok(afterComplete.lastSummary.length <= 81); // 80 + 截断省略号
  assert.equal(afterComplete.lastErrorAt, null);

  handlers.get("tool.error")({ toolName: "t", error: new Error("x") });
  assert.equal(typeof tracker.snapshot().lastErrorAt, "number");

  handlers.get("run.finally")({ status: "suspended", error: null });
  assert.equal(tracker.snapshot().activeRuns, 0);

  unsubscribe();
  handlers.get("run.before")({});
  assert.equal(notifications.length, 5); // 退订后不再通知
});

test("busy 期间 tool.before 触发节流的 busyHint，idle 期间不触发", () => {
  const handlers = new Map();
  const tracker = new PetActivityTracker();
  tracker.install({
    on: (event, handler) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  });

  // idle 下工具调用不产生提示
  handlers.get("tool.before")({ toolName: "run_bash_command" });
  assert.equal(tracker.snapshot().busyHint, null);

  handlers.get("run.before")({});
  handlers.get("tool.before")({ toolName: "run_bash_command" });
  assert.deepEqual(tracker.snapshot().busyHint, { anim: "原地敲击桌面互动", at: tracker.snapshot().busyHint.at });
  const firstAt = tracker.snapshot().busyHint.at;

  // 节流窗口内的第二个工具（不同动画）被忽略
  handlers.get("tool.before")({ toolName: "web_search" });
  assert.equal(tracker.snapshot().busyHint.at, firstAt);
});

test("/state 路由输出活跃度快照，未注入 tracker 时返回空基线", async () => {
  const tracker = new PetActivityTracker();
  const withTracker = await buildApp(await makeAssets([]), () => tracker.snapshot());
  const baseline = await withTracker.inject({ method: "GET", url: "/state" });
  assert.equal(baseline.statusCode, 200);
  assert.deepEqual(baseline.json(), EMPTY_SNAPSHOT);

  const withoutTracker = await buildApp(await makeAssets([]));
  assert.deepEqual((await withoutTracker.inject({ method: "GET", url: "/state" })).json(), {
    activeRuns: 0,
    lastErrorAt: null,
    lastCompletedAt: null,
    lastSummary: null,
    busyHint: null,
  });
});

test("Pet 路由以 public scope 贡献 /api/pet 前缀", async () => {
  const manager = new BackendPluginManager([createPetPlugin({ assetsRoot: await makeAssets([]) })]);
  await manager.register();
  assert.deepEqual(
    manager.routes("public").map((route) => route.prefix),
    ["/api/pet"],
  );
});

test("manifest 返回排序后的动画清单，素材目录缺失时为空数组", async () => {
  const app = await buildApp(await makeAssets(["idle.webm", "walk.webm", "note.txt"]));
  const res = await app.inject({ method: "GET", url: "/manifest" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().animations, ["idle", "walk"]);

  const missing = await buildApp(path.join(os.tmpdir(), `pet-missing-${Date.now()}`));
  const empty = await missing.inject({ method: "GET", url: "/manifest" });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json().animations, []);
});

test("thumb 路由流式返回 webm 字节并带缓存头，未知动画 404，兼容带扩展名 URL", async () => {
  const payload = Buffer.from([26, 69, 223, 163, 0, 1, 2, 3]);
  const root = await makeAssets([]);
  fs.writeFileSync(path.join(root, "idle.webm"), payload);
  const app = await buildApp(root);

  const res = await app.inject({ method: "GET", url: "/thumb/idle" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "video/webm");
  assert.equal(res.headers["content-length"], String(payload.length));
  assert.match(res.headers["cache-control"] ?? "", /public/);
  assert.ok(res.rawPayload.equals(payload));

  // 前端（dsh-pet 惯例）发送含 .webm 的 URL，不能拼成 idle.webm.webm
  const withExt = await app.inject({ method: "GET", url: "/thumb/idle.webm" });
  assert.equal(withExt.statusCode, 200);
  assert.ok(withExt.rawPayload.equals(payload));

  const missing = await app.inject({ method: "GET", url: "/thumb/unknown" });
  assert.equal(missing.statusCode, 404);
});

test("thumb 路由拒绝路径穿越与非法动画名（路由层 404 或校验层 400，均不可读文件）", async () => {
  const app = await buildApp(await makeAssets([]));
  for (const name of ["..", "a/b", "..%2F..%2Fpackage.json", "%2e%2e", "a%5Cb"]) {
    const res = await app.inject({ method: "GET", url: `/thumb/${name}` });
    assert.ok(
      res.statusCode === 400 || res.statusCode === 404,
      `expected 400/404 for ${name}, got ${res.statusCode}`,
    );
  }
});

async function buildApp(assetsRoot, activity) {
  const app = Fastify();
  await app.register(registerPetAssetRoutes, activity ? { assetsRoot, activity } : { assetsRoot });
  return app;
}

async function makeAssets(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-pet-test-"));
  for (const file of files) fs.writeFileSync(path.join(root, file), "x");
  return root;
}
