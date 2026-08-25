import { createReadStream } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";

/** 伺服插件 UI bundle（同源 /api/scheduler/ui/bundle.js），实现 pet 插件同款静态资产路由。 */
export interface SchedulerUiRouteOptions {
  uiRoot: string;
}

const UI_CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

export const registerSchedulerUiRoutes: FastifyPluginAsync<SchedulerUiRouteOptions> = async (app, options) => {
  const root = path.resolve(options.uiRoot);

  app.get("/ui/*", async (request, reply) => {
    const raw = (request.params as { "*": unknown })["*"];
    const relative = typeof raw === "string" ? raw : "";
    if (!isSafeUiAssetPath(relative)) {
      return await reply.code(400).send({ error: "invalid ui asset path" });
    }
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) {
      return await reply.code(400).send({ error: "invalid ui asset path" });
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return await reply.code(404).send({ error: "ui asset not found" });
    }
    if (!stat.isFile()) {
      return await reply.code(404).send({ error: "ui asset not found" });
    }
    const contentType = UI_CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    // JS/CSS 重建后同名变化：etag 协商缓存（no-cache 重验证 + 304），避免浏览器在
    // max-age 窗口内拿到旧 bundle。
    const revalidate = contentType.startsWith("application/javascript") || contentType.startsWith("text/css");
    if (revalidate) {
      const etag = `"${stat.mtimeMs.toString(16)}-${stat.size.toString(16)}"`;
      if (request.headers["if-none-match"] === etag) {
        return await reply.code(304).header("etag", etag).send();
      }
      reply.header("etag", etag);
      reply.header("cache-control", "no-cache");
    } else {
      reply.header("cache-control", "public, max-age=300");
    }
    reply.header("content-type", contentType);
    reply.header("content-length", stat.size);
    return await reply.send(createReadStream(file));
  });
};

/** 相对资产路径：非空、不以点开头、无控制字符、不含 .. 段。 */
function isSafeUiAssetPath(relative: string): boolean {
  if (relative.length === 0 || relative.startsWith(".")) return false;
  if (/[\x00-\x1f]/.test(relative)) return false;
  return relative.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
