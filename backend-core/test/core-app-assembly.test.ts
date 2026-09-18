import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { DeploymentApplicationResolvers, DeploymentRuntime } from "../src/app/deployment-runtime.js";
import { loadEnv, type AppEnv } from "../src/config/env.js";
import type { ControlPlane } from "../src/contracts/control-plane/index.js";
import type { RuntimeContainer } from "../src/contracts/runtime/runtime-container.js";
import { buildCoreApp } from "../src/core-app.js";
import type { DeploymentProfile, RequestIdentity } from "../src/identity/types.js";
import type {
  BackendPlugin,
  BackendPluginResourceContribution,
  BackendRouteHostContext,
} from "../src/plugins/backend-plugin.js";
import { createBackendResourceToken, provideBackendResource } from "../src/plugins/resource-registry.js";
import { AuthError, type IdentityProvider } from "../src/services/identity/index.js";
import type { RuntimeContainerRegistry } from "../src/services/runtime/runtime-container-registry.js";
import type { WsTicketService } from "../src/services/runtime/ws-ticket-service.js";
import { HttpError } from "../src/utils/errors.js";

/**
 * core-app 装配级冒烟：这里只断言「只有真实装配才会产生」的行为——错误映射、CORS/内容类型
 * 注册、前端兜底、插件生命周期与作用域挂载。路由实现本身的语义归各自的路由测试。
 */

const SMOKE_IDENTITY: RequestIdentity = {
  userId: "usr_smoke" as RequestIdentity["userId"],
  tenantId: "tnt_smoke" as RequestIdentity["tenantId"],
  role: "owner",
  permissions: [],
};

interface DeploymentCalls {
  acquires: string[];
  profileValidations: DeploymentProfile[];
  registryCreated: number;
  registryCloseAll: number;
  deploymentClose: number;
  order: string[];
}

interface TestDeployment {
  deployment: DeploymentRuntime;
  calls: DeploymentCalls;
}

function createTestDeployment(options: {
  settings?: Record<string, string>;
  identity?: RequestIdentity | null;
  hostResources?: readonly BackendPluginResourceContribution[];
  failRegistryClose?: boolean;
} = {}): TestDeployment {
  const calls: DeploymentCalls = {
    acquires: [],
    profileValidations: [],
    registryCreated: 0,
    registryCloseAll: 0,
    deploymentClose: 0,
    order: [],
  };
  const container = {
    interactionCoordinator: { source: "test" },
    systemConfig: { getSchema: () => ({ groups: [] }) },
  } as unknown as RuntimeContainer;
  const registry = {
    acquire: async (tenantId: string) => {
      calls.acquires.push(tenantId);
      return { tenantId, runtime: container, release: () => undefined };
    },
    closeAll: async () => {
      calls.order.push("registry.closeAll");
      calls.registryCloseAll += 1;
      if (options.failRegistryClose) throw new Error("registry shutdown failed");
    },
  } as unknown as RuntimeContainerRegistry;
  const identityProvider: IdentityProvider = {
    resolve: async () => {
      if (!options.identity) throw new AuthError("认证失败");
      return options.identity;
    },
  };
  const applicationResolvers = {
    resolveProviderApplication: () => ({}),
    resolveSessionApplication: () => ({}),
    resolveExecutionRead: () => ({}),
    resolveExecutionApplication: () => ({}),
    resolveAnalytics: () => ({}),
    resolveMonitoringApplication: () => ({}),
    resolveSessionFileApplication: () => ({}),
    resolveFileChangeApplication: () => ({}),
    resolveWorkspaceFileApplication: () => ({}),
  } as unknown as DeploymentApplicationResolvers;

  const deployment: DeploymentRuntime = {
    controlPlane: {
      settings: {
        get: async () => null,
        getAll: async () => options.settings ?? {},
        set: async () => undefined,
        setMany: async () => undefined,
      },
    } as unknown as ControlPlane,
    applications: applicationResolvers,
    wsTickets: {} as unknown as WsTicketService,
    ...(options.hostResources ? { hostResources: options.hostResources } : {}),
    validateProfile: (profile) => {
      calls.profileValidations.push(profile);
    },
    createRegistry: async () => {
      calls.registryCreated += 1;
      return registry;
    },
    createIdentityProvider: async () => identityProvider,
    close: async () => {
      calls.order.push("deployment.close");
      calls.deploymentClose += 1;
    },
  };
  return { deployment, calls };
}

interface SmokePluginHandle {
  plugin: BackendPlugin;
  events: string[];
  installHosts: (BackendRouteHostContext | undefined)[];
}

function createSmokePlugin(options: {
  claimAgui?: boolean;
  exposePublicUi?: boolean;
  failStop?: boolean;
} = {}): SmokePluginHandle {
  const events: string[] = [];
  const installHosts: (BackendRouteHostContext | undefined)[] = [];
  const plugin: BackendPlugin = {
    manifest: { id: "test.smoke", version: "1.0.0" },
    register(context) {
      events.push("register");
      context.routes.register("public", "/api/smoke", async (app, installContext) => {
        installHosts.push(installContext.host);
        app.get("/ok", async () => ({ ok: true }));
        app.get("/http-error", async () => {
          throw new HttpError(409, "conflict", "状态冲突");
        });
        app.get("/auth-error", async () => {
          throw new AuthError("凭证失效");
        });
        app.get("/zod-error", async () => {
          z.object({ name: z.string() }).parse({});
        });
        app.get("/unexpected", async () => {
          throw new Error("内部细节绝不能外泄");
        });
        app.get("/client-error", async () => {
          throw Object.assign(new Error("payload too large"), { statusCode: 413 });
        });
        app.post("/echo", async (request) => ({ received: request.body }));
      });
      context.routes.register("tenant", "/api/smoke-tenant", async (app) => {
        app.get("/who", async (request) => ({
          userId: request.identity.userId,
          tenantId: request.tenantId,
        }));
      });
      context.routes.register("management", "/api/smoke-managed", async (app) => {
        app.get("/ping", async () => ({ scope: "management" }));
      });
      context.routes.register("platform", "/api/smoke-platform", async (app) => {
        app.get("/ping", async () => ({ scope: "platform" }));
      });
      if (options.claimAgui) {
        context.routes.register("public", "/api/agui", async (app) => {
          app.post("/", async () => ({ agui: "plugin" }));
        });
      }
      if (options.exposePublicUi) {
        context.ui.register({
          bundleUrl: "/api/smoke/ui/bundle.js",
          exposePublic: true,
          views: [{ route: "/smoke", entry: "SmokePanel", title: "冒烟面板", placement: "management" }],
        });
      }
    },
    async start() {
      events.push("start");
    },
    async stop() {
      events.push("stop");
      if (options.failStop) throw new Error("plugin stop failed");
    },
  };
  return { plugin, events, installHosts };
}

function createEnv(dataRoot: string, extra: Record<string, string> = {}): AppEnv {
  return loadEnv({ RAG_DATA_ROOT: dataRoot, BACKEND_TS_LOG_LEVEL: "silent", ...extra });
}

/** 显式捕获失败路径：返回错误对象本身（未抛错时返回 null），便于断言其类型与构成。 */
async function catchError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

describe("core app assembly", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "core-app-assembly-"));
    // 交付仓库里 frontend-client/dist 可能存在；显式指向不存在的目录，避免测试依赖本机状态。
    process.env.FRONTEND_DIST = path.join(tempRoot, "absent-frontend");
  });

  afterEach(() => {
    delete process.env.FRONTEND_DIST;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("serves the root banner when no frontend bundle is present", async () => {
    const { deployment } = createTestDeployment();
    const app = await buildCoreApp({ env: createEnv(tempRoot), runtime: deployment });

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: "@ragsystem/backend-core", status: "running" });
    await app.close();
  });

  it("serves the SPA, refuses traversal, and 404s unknown API paths when a bundle exists", async () => {
    const distRoot = path.join(tempRoot, "frontend");
    mkdirSync(path.join(distRoot, "assets"), { recursive: true });
    writeFileSync(path.join(distRoot, "index.html"), "<html>smoke-index</html>");
    writeFileSync(path.join(distRoot, "assets", "app.js"), "console.log(1)");
    process.env.FRONTEND_DIST = distRoot;

    const { deployment } = createTestDeployment();
    const app = await buildCoreApp({ env: createEnv(tempRoot), runtime: deployment });

    const index = await app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.body).toContain("smoke-index");

    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("application/javascript");
    expect(asset.body).toBe("console.log(1)");

    const unknownApi = await app.inject({ method: "GET", url: "/api/definitely-missing" });
    expect(unknownApi.statusCode).toBe(404);
    expect(unknownApi.json()).toMatchObject({ statusCode: 404, error: "Not Found" });

    // 越界路径必须回落到 index.html，而不是把工作区文件读出去。
    const traversal = await app.inject({ method: "GET", url: "/..%2F..%2Fpackage.json" });
    expect(traversal.statusCode).toBe(200);
    expect(traversal.body).toContain("smoke-index");
    expect(traversal.body).not.toContain("\"name\"");
    await app.close();
  });

  it("maps HttpError, AuthError, ZodError, client statuses and unknown errors to distinct responses", async () => {
    const { plugin } = createSmokePlugin();
    const { deployment } = createTestDeployment();
    const app = await buildCoreApp({ env: createEnv(tempRoot), runtime: deployment, plugins: [plugin] });

    const httpError = await app.inject({ method: "GET", url: "/api/smoke/http-error" });
    expect(httpError.statusCode).toBe(409);
    expect(httpError.json()).toEqual({ success: false, message: "状态冲突", code: "conflict" });

    const authError = await app.inject({ method: "GET", url: "/api/smoke/auth-error" });
    expect(authError.statusCode).toBe(401);
    expect(authError.json()).toEqual({ success: false, message: "凭证失效", code: "unauthorized" });

    const zodError = await app.inject({ method: "GET", url: "/api/smoke/zod-error" });
    expect(zodError.statusCode).toBe(400);
    const zodBody = zodError.json() as { code: string; details: string[] };
    expect(zodBody.code).toBe("invalid_request");
    expect(zodBody.details[0]).toContain("name");

    const clientError = await app.inject({ method: "GET", url: "/api/smoke/client-error" });
    expect(clientError.statusCode).toBe(413);
    expect(clientError.json()).toMatchObject({ code: "invalid_request" });

    // 未知错误只回通用文案，细节留日志（不能把内部 message 泄漏给客户端）。
    const unexpected = await app.inject({ method: "GET", url: "/api/smoke/unexpected" });
    expect(unexpected.statusCode).toBe(500);
    expect(unexpected.json()).toEqual({ success: false, message: "internal server error" });
    expect(unexpected.body).not.toContain("内部细节");

    await app.close();
  });

  it("registers the YAML content type parser and rejects unparsable media types with 415", async () => {
    const { plugin } = createSmokePlugin();
    const { deployment } = createTestDeployment();
    const app = await buildCoreApp({ env: createEnv(tempRoot), runtime: deployment, plugins: [plugin] });

    const yaml = await app.inject({
      method: "POST",
      url: "/api/smoke/echo",
      headers: { "content-type": "application/x-yaml" },
      payload: "name: smoke",
    });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.json()).toEqual({ received: "name: smoke" });

    const xml = await app.inject({
      method: "POST",
      url: "/api/smoke/echo",
      headers: { "content-type": "application/xml" },
      payload: "<name>smoke</name>",
    });
    expect(xml.statusCode).toBe(415);
    expect(xml.json()).toMatchObject({ code: "unsupported_media_type" });
    await app.close();
  });

  it("exposes etag to cross-origin clients", async () => {
    const { deployment } = createTestDeployment();
    const app = await buildCoreApp({ env: createEnv(tempRoot), runtime: deployment });

    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { origin: "http://localhost:5173" },
    });
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(String(response.headers["access-control-expose-headers"])).toContain("etag");
    await app.close();
  });

  it("mounts plugin routes per scope and gates tenant scope behind identity", async () => {
    const { plugin, installHosts } = createSmokePlugin();
    const markerToken = createBackendResourceToken<string>("test.assembly.marker", "test-owner");
    const hostResources = [provideBackendResource(markerToken, "marker-value", "test-owner")];
    const { deployment, calls } = createTestDeployment({ identity: SMOKE_IDENTITY, hostResources });
    const app = await buildCoreApp({ env: createEnv(tempRoot), runtime: deployment, plugins: [plugin] });

    // 安装期就拿得到宿主上下文：registry 与「宿主资源 + 插件资源」合并视图。
    expect(installHosts).toHaveLength(1);
    expect(installHosts[0]?.resources).toEqual(expect.arrayContaining(hostResources));

    const publicRoute = await app.inject({ method: "GET", url: "/api/smoke/ok" });
    expect(publicRoute.statusCode).toBe(200);

    const tenantRoute = await app.inject({ method: "GET", url: "/api/smoke-tenant/who" });
    expect(tenantRoute.statusCode).toBe(200);
    expect(tenantRoute.json()).toEqual({ userId: "usr_smoke", tenantId: "tnt_smoke" });
    expect(calls.acquires).toEqual(["tnt_smoke"]);

    expect((await app.inject({ method: "GET", url: "/api/smoke-managed/ping" })).json()).toEqual({ scope: "management" });
    expect((await app.inject({ method: "GET", url: "/api/smoke-platform/ping" })).json()).toEqual({ scope: "platform" });
    await app.close();
  });

  it("rejects tenant-scope plugin routes when identity resolution fails", async () => {
    const { plugin } = createSmokePlugin();
    const { deployment, calls } = createTestDeployment({ identity: null });
    const app = await buildCoreApp({ env: createEnv(tempRoot), runtime: deployment, plugins: [plugin] });

    const denied = await app.inject({ method: "GET", url: "/api/smoke-tenant/who" });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ code: "unauthorized" });
    // 认证失败发生在租户运行时申请之前。
    expect(calls.acquires).toEqual([]);
    await app.close();
  });

  it("publishes plugin UI manifests on the public and tenant plugin endpoints", async () => {
    const { plugin } = createSmokePlugin({ exposePublicUi: true });
    const { deployment } = createTestDeployment({ identity: SMOKE_IDENTITY });
    const app = await buildCoreApp({ env: createEnv(tempRoot), runtime: deployment, plugins: [plugin] });

    const manifests = await app.inject({ method: "GET", url: "/api/plugins/ui-manifests" });
    expect(manifests.statusCode).toBe(200);
    expect(manifests.json().data.plugins).toEqual([
      {
        id: "test.smoke",
        bundleUrl: "/api/smoke/ui/bundle.js",
        views: [{ route: "/smoke", entry: "SmokePanel", title: "冒烟面板", placement: "management" }],
      },
    ]);

    const listing = await app.inject({ method: "GET", url: "/api/plugins/" });
    expect(listing.statusCode).toBe(200);
    const listed = listing.json().data.plugins as { id: string; version: string; ui: unknown }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "test.smoke", version: "1.0.0" });
    expect(listed[0]?.ui).toMatchObject({ bundleUrl: "/api/smoke/ui/bundle.js" });
    await app.close();
  });

  it("lets a plugin take over /api/agui instead of registering the built-in route twice", async () => {
    const { plugin } = createSmokePlugin({ claimAgui: true });
    const { deployment } = createTestDeployment();
    const app = await buildCoreApp({ env: createEnv(tempRoot), runtime: deployment, plugins: [plugin] });

    const response = await app.inject({ method: "POST", url: "/api/agui/" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ agui: "plugin" });
    await app.close();
  });

  it("runs plugin register/start at build time and stops them before closing the deployment", async () => {
    const { plugin, events } = createSmokePlugin();
    const { deployment, calls } = createTestDeployment();
    const app = await buildCoreApp({ env: createEnv(tempRoot), runtime: deployment, plugins: [plugin] });

    expect(events).toEqual(["register", "start"]);
    calls.order.length = 0;

    await app.close();
    expect(events).toEqual(["register", "start", "stop"]);
    expect(calls.order).toEqual(["registry.closeAll", "deployment.close"]);
    expect(calls.registryCreated).toBe(1);
  });

  it("aggregates shutdown failures instead of stopping at the first one", async () => {
    const { plugin, events } = createSmokePlugin({ failStop: true });
    const { deployment, calls } = createTestDeployment({ failRegistryClose: true });
    const app = await buildCoreApp({ env: createEnv(tempRoot), runtime: deployment, plugins: [plugin] });

    const failure = await catchError(() => app.close());
    expect(failure).toBeInstanceOf(AggregateError);
    // 两个独立失败都要出现在聚合结果里，且都不能阻止后续收尾步骤。
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(events).toEqual(["register", "start", "stop"]);
    expect(calls.order).toEqual(["registry.closeAll", "deployment.close"]);
    expect(calls.deploymentClose).toBe(1);
  });

  it("resolves the deployment profile from control-plane settings", async () => {
    const { deployment, calls } = createTestDeployment({
      settings: { auth_mode: "password", tenancy_mode: "multi" },
      identity: SMOKE_IDENTITY,
    });
    const app = await buildCoreApp({
      env: createEnv(tempRoot, { SESSION_JWT_SECRET: "smoke-secret-smoke-secret-smoke-32" }),
      runtime: deployment,
    });

    expect(calls.profileValidations.at(-1)).toMatchObject({ auth: "password", tenancy: "multi" });
    await app.close();
  });

  it("fails fast when password auth is selected without a session secret", async () => {
    const { deployment } = createTestDeployment({ settings: { auth_mode: "password" } });
    const failure = await catchError(() => buildCoreApp({ env: createEnv(tempRoot), runtime: deployment }));

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/SESSION_JWT_SECRET/);
  });

  it("rejects a deployment-supplied profile the deployment declares invalid", async () => {
    // tenancy 通过内核自身校验，由部署侧 validateProfile 决定是否接受。
    const { deployment } = createTestDeployment({ settings: { tenancy_mode: "multi" } });
    deployment.validateProfile = () => {
      throw new Error("该部署形态不允许 multi tenancy");
    };

    const failure = await catchError(() => buildCoreApp({ env: createEnv(tempRoot), runtime: deployment }));
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/不允许 multi tenancy/);
  });
});
