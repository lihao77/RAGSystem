/**
 * widget 宿主页 demo server。
 *
 * 模拟第三方嵌入方服务端：启动时用 app-key/secret 向后端换短时 token，
 * 渲染 index.html 注入 token/backendBase，并把 widget umd bundle 暴露给浏览器。
 *
 * 运行前置：
 *   1. 后端配 WIDGET_JWT_SECRET 启动（见 backend-ts/.env.example）。
 *   2. 用 CLI 建 widget app 拿 app-key/secret：
 *        npx tsx src/cli/widget-app.ts create --name "demo" --origins http://localhost:4321
 *   3. 设环境变量后启动本 demo：
 *        WIDGET_APP_KEY=wid_pk_... WIDGET_SECRET=wid_sk_... npm start
 *   4. 浏览器开 http://localhost:4321，widget FAB 出现在右下角。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const BACKEND_BASE = (process.env.WIDGET_BACKEND_BASE || "http://localhost:5002").replace(/\/$/, "");

// 读同级 .env（如存在）补充环境变量——跨 shell 友好（PowerShell $env: 与 CMD set 语法不同，.env 统一）。
const dotEnvPath = path.resolve(import.meta.dirname, ".env");
if (fs.existsSync(dotEnvPath)) {
  for (const raw of fs.readFileSync(dotEnvPath, "utf8").split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(raw.trim());
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

const APP_KEY = process.env.WIDGET_APP_KEY;
const SECRET = process.env.WIDGET_SECRET;
const PORT = Number(process.env.DEMO_PORT || 4321);
const BUNDLE = path.resolve(import.meta.dirname, "../../packages/agent-widget/dist/ragsystem-widget.umd.cjs");
const INDEX_HTML = path.resolve(import.meta.dirname, "index.html");

if (!APP_KEY || !SECRET) {
  console.error("请先设 WIDGET_APP_KEY 与 WIDGET_SECRET（用 cli/widget-app.ts create 获取）");
  process.exit(1);
}

async function fetchToken() {
  const res = await fetch(`${BACKEND_BASE}/api/widget/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_key: APP_KEY, secret: SECRET }),
  });
  if (!res.ok) {
    throw new Error(`换 token 失败: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json());
  if (!json.data?.token) {
    throw new Error("换 token 失败: 响应缺 token");
  }
  return json.data.token;
}

let cachedToken = null;
let cachedAt = 0;
const TOKEN_TTL_MS = 14 * 60 * 1000; // 留 1min 余量（后端 token TTL 15min）

async function getToken() {
  if (cachedToken && Date.now() - cachedAt < TOKEN_TTL_MS) {
    return cachedToken;
  }
  cachedToken = await fetchToken();
  cachedAt = Date.now();
  return cachedToken;
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  if (url === "/widget.js") {
    try {
      const buf = fs.readFileSync(BUNDLE);
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(buf);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("widget bundle 未构建，请先在 packages/agent-widget 跑 npm run build");
    }
    return;
  }
  if (url === "/" || url === "/index.html") {
    let token;
    try {
      token = await getToken();
    } catch (err) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`换 token 失败，请确认后端已用 WIDGET_JWT_SECRET 启动且 app-key/secret 正确：\n${err.message}`);
      return;
    }
    const html = fs.readFileSync(INDEX_HTML, "utf8")
      .replaceAll("{{BACKEND_BASE}}", BACKEND_BASE)
      .replaceAll("{{TOKEN}}", token);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`widget demo 宿主页: http://localhost:${PORT}`);
  console.log(`后端: ${BACKEND_BASE}`);
});
