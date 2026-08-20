import { createReadStream } from "node:fs";
import fs from "node:fs";
import path from "node:path";

import type { FastifyPluginAsync } from "fastify";

import type { PetActivitySnapshot } from "./pet-activity.js";

export interface PetAssetRouteOptions {
  /** thumb 动画目录（内含 `<动画名>.webm`）。 */
  readonly assetsRoot: string;
  /** agent 运行活跃度快照（缺省时 /state 返回全空基线）。 */
  readonly activity?: () => PetActivitySnapshot;
  /** 订阅活跃度变化（/events SSE 推送用）。 */
  readonly subscribeActivity?: (listener: (snapshot: PetActivitySnapshot) => void) => () => void;
}

const EMPTY_ACTIVITY: PetActivitySnapshot = {
  activeRuns: 0,
  lastErrorAt: null,
  lastCompletedAt: null,
  lastSummary: null,
  busyHint: null,
};

/**
 * 桌宠插件路由（挂载于 /api/pet 前缀，public scope）：
 *   GET /manifest    可用动画名清单（素材目录缺失时为空数组，前端据此隐藏宠物）
 *   GET /state       agent 运行活跃度（activeRuns / lastErrorAt / lastCompletedAt）
 *   GET /events      活跃度变化 SSE 推送（前端优先于 /state 轮询，短 run 不漏拍）
 *   GET /thumb/:name 流式返回 webm（带缓存头；动画名做防穿越校验）
 */
export const registerPetAssetRoutes: FastifyPluginAsync<PetAssetRouteOptions> = async (app, options) => {
  const root = path.resolve(options.assetsRoot);

  app.get("/manifest", async () => {
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(root);
    } catch {
      // 素材尚未拉取（npm run fetch-assets）时输出空清单
    }
    const animations = entries
      .filter((name) => name.endsWith(".webm"))
      .map((name) => name.slice(0, -".webm".length))
      .sort();
    return { animations };
  });

  app.get("/state", async () => {
    return options.activity ? options.activity() : EMPTY_ACTIVITY;
  });

  // 活跃度 SSE：连接即推当前快照，此后每次变化即时推送；15s 心跳防中间层断连。
  app.get("/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    const send = (snapshot: PetActivitySnapshot) => {
      reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    };
    send(options.activity ? options.activity() : EMPTY_ACTIVITY);
    const unsubscribe = options.subscribeActivity?.(send);
    const heartbeat = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    });
  });

  app.get("/thumb/:name", async (request, reply) => {
    const raw = (request.params as { name?: unknown }).name;
    // 兼容带扩展名（dsh-pet 客户端惯例：/thumb/<动画名>.webm）与不带扩展名两种请求
    const name = typeof raw === "string" && raw.endsWith(".webm") ? raw.slice(0, -".webm".length) : raw;
    if (typeof name !== "string" || !isSafeAnimationName(name)) {
      return await reply.code(400).send({ error: "invalid animation name" });
    }
    const file = path.join(root, `${name}.webm`);
    // 双保险：join 保留字面量、resolve 折叠 ..，两者不一致说明路径被构造过
    if (path.resolve(file) !== file || !file.startsWith(root + path.sep)) {
      return await reply.code(400).send({ error: "invalid animation name" });
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return await reply.code(404).send({ error: "asset not found" });
    }
    if (!stat.isFile()) {
      return await reply.code(404).send({ error: "asset not found" });
    }
    reply.header("content-type", "video/webm");
    reply.header("content-length", stat.size);
    reply.header("cache-control", "public, max-age=3600");
    return await reply.send(createReadStream(file));
  });
};

/** 动画名仅允许非空、非点开头、不含路径分隔符与控制字符（参数经路由层 URL 解码后再校验）。 */
function isSafeAnimationName(name: string): boolean {
  if (name.length === 0 || name.startsWith(".")) return false;
  return !/[\x00-\x1f\\/]/.test(name);
}
