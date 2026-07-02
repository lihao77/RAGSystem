/**
 * iframe 跨源控制桥 demo server（无 token 内部嵌入版）。
 *
 * 双端口模拟跨源：
 *   - HOST（默认 4321）：主页面（widget + iframe 宿主）。注入 host.html（backendBase + frame origin），
 *     伺服 /widget.js（widget bundle）、/host-bridge.js（host bridge bundle）。
 *   - FRAME（默认 5175）：iframe 页（系统 B），纯静态伺服 frame.html、/frame-bridge.js。
 *
 * 无 token：widget 走普通会话（POST /api/agent/sessions 零鉴权，WS 不校验 token）。
 * 仅需后端 CORS_ORIGINS 白名单含 HOST origin（HTTP 建会话带 Origin 走 CORS；WS 路由对普通会话不校验 origin）。
 *
 * 运行：
 *   1. 后端启动，CORS_ORIGINS 含 http://localhost:4321（或未设=全开）。
 *   2. node examples/iframe-cross-origin-demo/server.mjs
 *   3. 浏览器开 http://localhost:4321。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const BACKEND_BASE = (process.env.WIDGET_BACKEND_BASE || "http://localhost:5002").replace(/\/$/, "");
const HOST_PORT = Number(process.env.HOST_PORT || 4321);
const FRAME_PORT = Number(process.env.FRAME_PORT || 5175);

const ROOT = import.meta.dirname;
const BUNDLE = (name) => path.resolve(ROOT, `../../packages/agent-widget/dist/${name}`);

function sendBundle(res, bundleFile) {
  try {
    const buf = fs.readFileSync(BUNDLE(bundleFile));
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("bundle 未构建，请先在 packages/agent-widget 跑 npm run build");
  }
}

// HOST 端口：注入 host.html；bundle 直读 dist。无 token——不做 app-key/secret 换取。
const hostServer = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/widget.js") return sendBundle(res, "ragsystem-widget.umd.cjs");
  if (url === "/host-bridge.js") return sendBundle(res, "ragsystem-host-bridge.umd.cjs");
  if (url === "/" || url === "/index.html") {
    const html = fs.readFileSync(path.resolve(ROOT, "host.html"), "utf8")
      .replaceAll("{{BACKEND_BASE}}", BACKEND_BASE)
      .replaceAll("{{FRAME_ORIGIN}}", `http://localhost:${FRAME_PORT}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(html);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found: " + url);
});

// FRAME 端口：纯静态（frame.html + frame-bridge bundle），不连后端。
const frameServer = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/frame-bridge.js") return sendBundle(res, "ragsystem-frame-bridge.umd.cjs");
  if (url === "/" || url === "/frame.html") {
    const html = fs.readFileSync(path.resolve(ROOT, "frame.html"), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(html);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found: " + url);
});

hostServer.on("error", (e) => { console.error("HOST 端口错误:", e); process.exit(1); });
frameServer.on("error", (e) => { console.error("FRAME 端口错误:", e); process.exit(1); });

hostServer.listen(HOST_PORT, () => {
  console.log(`主页面（widget + iframe 宿主，无 token）: http://localhost:${HOST_PORT}`);
  console.log(`后端: ${BACKEND_BASE}`);
});
frameServer.listen(FRAME_PORT, () => {
  console.log(`iframe 页（系统 B，跨源）: http://localhost:${FRAME_PORT}`);
});
