// delegation-demo 本地静态服务。
// 必要性：demo 若用 file:// 打开，浏览器 Origin 为 null，不在后端 CORS 白名单内 → 预检 OPTIONS 404。
//         从白名单内的 http origin 伺服即可（默认 5174，在后端 .env 的 CORS_ORIGINS 内）。
// 用法：node examples/delegation-demo/server.mjs   →   浏览器开 http://localhost:5174
//       页面里「后端地址」填 http://localhost:5002。
//       改端口用 DEMO_PORT（须同步加入后端 CORS_ORIGINS 白名单）。
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.DEMO_PORT || 5173);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found: " + urlPath); return; }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(buf);
  });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 被占用。换个白名单内端口：DEMO_PORT=5173 node examples/delegation-demo/server.mjs`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`delegation-demo → http://localhost:${PORT}`);
  console.log(`后端地址填：http://localhost:5002`);
});
