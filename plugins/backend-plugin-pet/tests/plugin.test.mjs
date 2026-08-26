import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify from "fastify";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";

import { createPetPlugin, mapToolToAnimation, PetActivityTracker, registerPetAssetRoutes, PET_PLUGIN_ID, createPetSystemConfigExtension, resolvePetConfig, DEFAULT_PET_CONFIG } from "../dist/index.js";

const EMPTY_SNAPSHOT = { activeRuns: 0, lastErrorAt: null, lastCompletedAt: null, lastSummary: null, busyHint: null, lastInteraction: null };

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
    lastInteraction: null,
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

test("ui 清单注册：exposePublic 的 standalone 视图进入 BackendPluginManager.listUi", async () => {
  const manager = new BackendPluginManager([createPetPlugin()]);
  await manager.register();
  const ui = manager.listUi();
  assert.equal(ui.length, 1);
  assert.equal(ui[0].pluginId, PET_PLUGIN_ID);
  assert.equal(ui[0].manifest.bundleUrl, "/api/pet/ui/bundle.js");
  assert.equal(ui[0].manifest.exposePublic, true);
  assert.equal(ui[0].manifest.views[0].route, "/pet");
  await manager.stop();
});

test("systemConfig 扩展注册 pet 组并回灌已存值；resolvePetConfig 非法值回退默认", async () => {
  const extension = createPetSystemConfigExtension({ default_animation: "smug", scale: 1.5, notice_enabled: false });
  assert.equal(extension.defaults.pet.default_animation, "smug");
  assert.equal(extension.defaults.pet.scale, 1.5);
  const group = extension.groups.find((g) => g.key === "pet");
  assert.ok(group);
  assert.deepEqual(
    group.fields.map((f) => f.key).sort(),
    ["default_animation", "notice_enabled", "scale"],
  );

  assert.deepEqual(resolvePetConfig({ scale: "not-a-number" }), DEFAULT_PET_CONFIG);
  assert.deepEqual(resolvePetConfig(undefined), DEFAULT_PET_CONFIG);
  assert.deepEqual(resolvePetConfig({ scale: 0.75 }), { default_animation: "idle", scale: 0.75, notice_enabled: true });
});

test("runtime 注册 systemConfig 扩展、订阅交互通知进快照，dispose 时全部反注册", async () => {
  const registered = [];
  let notifyInteraction = null;
  const port = {
    getSection: () => undefined,
    registerExtension: (id, ext) => {
      registered.push(id);
      assert.equal(ext.groups[0].key, "pet");
      return () => registered.push(`unregister:${id}`);
    },
  };
  const pendingInteractions = {
    onInteractionRequired: (handler) => {
      notifyInteraction = handler;
      return () => registered.push("unsubscribe:interactions");
    },
  };
  const tracker = new PetActivityTracker();
  const manager = new BackendPluginManager([createPetPlugin({ activityTracker: tracker })]);
  await manager.register();
  const contributions = manager.runtimeContributions();
  const runtime = await contributions.createRuntime({ systemConfig: port, pendingInteractions });
  assert.equal(typeof notifyInteraction, "function");

  // 审批进入 pending → tracker 快照携带 lastInteraction（SSE 推给宠物页弹通知）
  notifyInteraction({ id: "i-1", kind: "approval", sessionId: "s", runId: "r", tool: "Bash", prompt: null, reason: "高危命令" });
  const { lastInteraction } = tracker.snapshot();
  assert.equal(lastInteraction?.id, "i-1");
  assert.equal(lastInteraction?.kind, "approval");
  assert.equal(lastInteraction?.tool, "Bash");
  assert.equal(lastInteraction?.reason, "高危命令");
  assert.ok(Number.isFinite(lastInteraction?.at));

  runtime.dispose();
  assert.deepEqual(registered, [PET_PLUGIN_ID, "unsubscribe:interactions", `unregister:${PET_PLUGIN_ID}`]);
  await manager.stop();
});

test("tenant /settings 路由经 request.container.systemConfig 返回合并后的 pet 配置", async () => {
  const contributionsOf = (plugin) => {
    const manager = new BackendPluginManager([plugin]);
    return manager.register().then(() => manager);
  };
  const manager = await contributionsOf(createPetPlugin());
  const app = Fastify();
  app.decorateRequest("container", null);
  app.addHook("onRequest", async (request) => {
    request.container = {
      systemConfig: { getSchema: () => ({ groups: [] }), getSection: () => ({ scale: 2, notice_enabled: false }) },
    };
  });
  for (const contribution of manager.routes("tenant")) {
    await app.register(contribution.install, { prefix: contribution.prefix });
  }
  const res = await app.inject({ method: "GET", url: "/api/pet/settings" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { default_animation: "idle", scale: 2, notice_enabled: false });
  await app.close();
  await manager.stop();
});

test("ui bundle 伺服：bundle.js/style.css 带 content-type，穿越路径被拒，缺失目录 404", async () => {
  const uiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-pet-ui-test-"));
  fs.writeFileSync(path.join(uiRoot, "bundle.js"), "export function mountView(){}");
  fs.writeFileSync(path.join(uiRoot, "style.css"), ".pet{}");
  const app = Fastify();
  const { registerPetUiRoutes } = await import("../dist/index.js");
  await app.register(registerPetUiRoutes, { uiRoot });

  const bundle = await app.inject({ method: "GET", url: "/ui/bundle.js" });
  assert.equal(bundle.statusCode, 200);
  assert.equal(bundle.headers["content-type"], "application/javascript; charset=utf-8");

  const css = await app.inject({ method: "GET", url: "/ui/style.css" });
  assert.equal(css.statusCode, 200);
  assert.equal(css.headers["content-type"], "text/css; charset=utf-8");

  const traversal = await app.inject({ method: "GET", url: "/ui/..%2F..%2Fpackage.json" });
  assert.ok(traversal.statusCode === 400 || traversal.statusCode === 404, `got ${traversal.statusCode}`);

  const missing = await Fastify();
  await missing.register(registerPetUiRoutes, { uiRoot: path.join(uiRoot, "nope") });
  assert.equal((await missing.inject({ method: "GET", url: "/ui/bundle.js" })).statusCode, 404);
  await app.close();
  await missing.close();
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
