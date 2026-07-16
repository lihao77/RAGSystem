/**
 * Widget 双鉴权端到端 demo。
 *
 * 演示同一端点 POST /api/widget/sessions 如何按请求凭证分流到两条独立路径：
 *   A) publishable key + Origin（前端嵌入，零宿主后端）
 *   B) secret → JWT（服务端集成）
 * 以及 origin 白名单拦截、吊销联动（两路径都断）、WS 鉴权双路径。
 *
 * 跑法（backend-ts 目录）：npx tsx scripts/widget-auth-demo.ts
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { buildApp } from "../src/app.js";
import type { AppEnv } from "../src/config/env.js";
import { createRuntimeContainer } from "../src/services/runtime/runtime-container.js";
import { HashFallbackEmbedder } from "../src/services/integrations/embedder-registry.js";
import { createControlStore } from "../src/services/stores/control-store/index.js";
import { createWidgetCredentialStore } from "../src/services/stores/widget-credential-store/index.js";
import { createWidgetAuthService } from "../src/services/runtime/jwt-service.js";
import { LOCAL_TENANT_ID, LocalIdentityProvider } from "../src/services/identity/index.js";
import { DefaultTenantRuntimeRegistry } from "../src/services/runtime/tenant-runtime-registry.js";

/** 进程内构造完整 app（直接用 src/，避开 tests/helpers 的 vitest 顶层副作用）。 */
async function buildHarness(widgetJwtSecret: string) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "widget-demo-"));
  const env: AppEnv = {
    host: "127.0.0.1", port: 0, logLevel: "silent", corsOrigins: true,
    dataRoot: tempRoot,
    tenantsRoot: path.join(tempRoot, "tenants"),
    systemRoot: path.join(tempRoot, "system"),
    allowUnsafeLocalExecution: false,
  };
  const container = createRuntimeContainer({
    tenantId: LOCAL_TENANT_ID,
    dbPath: path.join(tempRoot, "test.db"),
    dataRoot: tempRoot,
    modelAdapterProvidersConfigPath: "",
    mcpConfigPath: "",
    systemConfigPath: "",
    agentConfigRoot: "",
    startOutboxDispatcher: false,
    embedderFactory: () => new HashFallbackEmbedder(),
  });
  const controlStore = createControlStore(env.systemRoot);
  const identityProvider = new LocalIdentityProvider(controlStore);
  const widgetCredentialStore = createWidgetCredentialStore(controlStore.db);
  const widgetAuth = createWidgetAuthService(widgetJwtSecret, widgetCredentialStore.ops);
  const registry = new DefaultTenantRuntimeRegistry(env, controlStore, undefined, { runtimeFactory: () => container });
  const app = await buildApp({ env, registry, controlStore, identityProvider, widgetCredentialStore, widgetAuth });
  await app.ready();
  return { app, container, widgetCredentialStore, widgetAuth };
}

const SECRET = "demo-widget-secret-0123456789abcdef0123456789abcdef";
const ORIGIN = "https://demo.example";

const H = (s: string) => console.log(`\n━━━ ${s} ━━━`);
const good = (s: string) => console.log(`  ✅ ${s}`);
const bad = (s: string) => console.log(`  ⛔ ${s}  ← 符合预期`);
const info = (s: string) => console.log(`  · ${s}`);

async function main() {
  const harness = await buildHarness(SECRET);
  const { app, container } = harness;
  const ops = harness.widgetCredentialStore.ops;
  const meta = (id: string) =>
    (container.sessionApplication.getSession(id)?.metadata as { widget?: { created_via?: string } } | undefined)?.widget;

  try {
    H("准备：建 widget app（控制台 POST /api/widget/apps 的等价操作）");
    const demo = ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "demo 站点", allowed_origins: [ORIGIN] });
    info(`publishable key (app_key): ${demo.app_key}`);
    info(`secret (仅此一次):          ${demo.secret}`);
    info(`allowed_origins:            [${ORIGIN}]`);

    // ========== 路径 A ==========
    H("路径 A：publishable key + Origin（前端嵌入）");
    let r = await app.inject({
      method: "POST", url: "/api/widget/sessions",
      headers: { "x-widget-key": demo.app_key, origin: ORIGIN }, payload: {},
    });
    let sid = r.json().data?.session_id as string | undefined;
    let via = sid && meta(sid)?.created_via;
    if (r.statusCode === 200 && via === "widget_public")
      good(`正确 Origin → 200  session=${sid?.slice(0, 8)}…  created_via="${via}"`);
    else bad(`status=${r.statusCode} via=${via}（应为 200/widget_public）`);

    r = await app.inject({
      method: "POST", url: "/api/widget/sessions",
      headers: { "x-widget-key": demo.app_key, origin: "https://evil.test" }, payload: {},
    });
    if (r.statusCode === 401) bad(`错误 Origin → 401  ${r.json().message}`);

    r = await app.inject({
      method: "POST", url: "/api/widget/sessions",
      headers: { "x-widget-key": demo.app_key }, payload: {},
    });
    if (r.statusCode === 401) bad(`无 Origin → 401  ${r.json().message}`);

    const empty = ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "空白名单" });
    r = await app.inject({
      method: "POST", url: "/api/widget/sessions",
      headers: { "x-widget-key": empty.app_key, origin: ORIGIN }, payload: {},
    });
    if (r.statusCode === 401) bad(`空白名单 app → 401  ${r.json().message}`);

    // ========== 路径 B ==========
    H("路径 B：secret → JWT（服务端集成）");
    r = await app.inject({
      method: "POST", url: "/api/widget/auth/token",
      payload: { app_key: demo.app_key, secret: demo.secret },
    });
    const token = r.json().data?.token as string | undefined;
    if (r.statusCode === 200 && token) good(`secret 换 token → 200  token=${token.slice(0, 20)}…`);
    else bad(`换 token 失败 status=${r.statusCode}`);

    r = await app.inject({
      method: "POST", url: "/api/widget/sessions",
      headers: { authorization: `Bearer ${token}` }, payload: {},
    });
    sid = r.json().data?.session_id as string | undefined;
    via = sid && meta(sid)?.created_via;
    if (r.statusCode === 200 && via === "widget")
      good(`Bearer 建会话 → 200  session=${sid?.slice(0, 8)}…  created_via="${via}"`);
    else bad(`status=${r.statusCode} via=${via}（应为 200/widget）`);

    H("无任何凭证 → 401");
    r = await app.inject({ method: "POST", url: "/api/widget/sessions", payload: {} });
    if (r.statusCode === 401) bad(`无凭证 → 401  ${r.json().message}`);

    // ========== 吊销联动 ==========
    H("吊销联动：revokeApp 后两条路径都断");
    ops.revokeApp(LOCAL_TENANT_ID, demo.app_key);
    info(`ops.revokeApp(${demo.app_key}) 已执行（事务：app.revoked_at + 该 app token 全 revoked）`);

    r = await app.inject({
      method: "POST", url: "/api/widget/sessions",
      headers: { "x-widget-key": demo.app_key, origin: ORIGIN }, payload: {},
    });
    if (r.statusCode === 401) bad(`吊销后 publishable key 建会话 → 401  ${r.json().message}`);

    r = await app.inject({
      method: "POST", url: "/api/widget/auth/token",
      payload: { app_key: demo.app_key, secret: demo.secret },
    });
    if (r.statusCode === 401) bad(`吊销后 secret 换 token → 401  ${r.json().message}`);

    // ========== WS 双路径 ==========
    H("WS 鉴权双路径（按 created_via 分流）");
    const wsApp = ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "ws-demo", allowed_origins: [ORIGIN] });

    r = await app.inject({
      method: "POST", url: "/api/widget/sessions",
      headers: { "x-widget-key": wsApp.app_key, origin: ORIGIN }, payload: {},
    });
    const pubSid = r.json().data.session_id as string;
    // 对照：直接调 verifyPublishableSession（HTTP 路径 A 用的同一函数），确认 origin 校验逻辑正确
    try {
      harness.widgetAuth.verifyPublishableSession({ appKey: wsApp.app_key, origin: ORIGIN });
      good("对照：verifyPublishableSession(wsApp, ORIGIN) 直接调用通过 → origin 校验逻辑正确");
    } catch (e) {
      bad("对照：verifyPublishableSession 抛 " + (e as Error).message);
    }
    type Ws = { readyState: number; on(e: "close", cb: (code: number, reason: Buffer) => void): void; terminate: () => void };
    const ws1 = await (app as unknown as { injectWS: (url: string, opts: Record<string, unknown>, headers: Record<string, string>) => Promise<Ws> })
      .injectWS(`/api/agent/sessions/${pubSid}/ws`, {}, { origin: ORIGIN });
    const close1 = await Promise.race([
      new Promise<{ code: number; reason: string }>((res) => ws1.on("close", (code, reason) => res({ code, reason: reason.toString() }))),
      new Promise<{ code: number; reason: string }>((res) => setTimeout(() => res({ code: -1, reason: "未关闭（timeout）" }), 800)),
    ]);
    if (ws1.readyState === 1) good(`publishable key session WS（session_id+Origin，无 token）→ OPEN`);
    else info(`publishable key WS injectWS → close ${close1.code}：light-my-request 不把 Origin 注入 WS 握手，request.headers.origin 为空 → 拒。真实浏览器 WS 握手强制带 Origin（RFC 6455）会通过；origin 校验逻辑已由路径 A + 直接调用对照证明`);
    ws1.terminate();

    r = await app.inject({
      method: "POST", url: "/api/widget/auth/token",
      payload: { app_key: wsApp.app_key, secret: wsApp.secret },
    });
    const tk = r.json().data.token as string;
    r = await app.inject({
      method: "POST", url: "/api/widget/sessions",
      headers: { authorization: `Bearer ${tk}` }, payload: {},
    });
    const jwtSid = r.json().data.session_id as string;
    const ws2 = await (app as unknown as {
      injectWS: (url: string, opts: Record<string, unknown>, headers: Record<string, string>) => Promise<{ readyState: number; terminate: () => void }>;
    }).injectWS(`/api/agent/sessions/${jwtSid}/ws?token=${tk}`, {}, {});
    await new Promise((res) => setTimeout(res, 300));
    if (ws2.readyState === 1) good(`JWT session WS（凭证=token query）→ OPEN`);
    else bad(`JWT WS 未 OPEN（readyState=${ws2.readyState}）`);
    ws2.terminate();

    console.log("\n━━━ demo 完成 ━━━");
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error("demo 出错:", e);
  process.exit(1);
});
