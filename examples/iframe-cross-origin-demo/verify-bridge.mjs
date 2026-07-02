/**
 * bridge 协议回归验证脚本：node 加载两个 bridge bundle，mock message 通道，验证核心闭环。
 * 跑法：node examples/iframe-cross-origin-demo/verify-bridge.mjs（不依赖浏览器/后端）。
 *   - frame-bridge：serve→ready 上报、收 request→response、未注册工具、白名单外静默、builtins click
 *   - host-bridge：connect→hello、收 ready→onTools、call→response、错 origin response 忽略
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const FB = require("../../packages/agent-widget/dist/ragsystem-frame-bridge.umd.cjs");
const HB = require("../../packages/agent-widget/dist/ragsystem-host-bridge.umd.cjs");

// ---- mock 浏览器全局（node 无 window/document/postMessage）----
const listeners = [];
globalThis.window = globalThis;
globalThis.parent = globalThis;
globalThis.addEventListener = (type, h) => { if (type === "message") listeners.push(h); };
globalThis.removeEventListener = () => {};
if (!globalThis.crypto) globalThis.crypto = { randomUUID: () => "uuid-" + Math.random().toString(36).slice(2, 10) };
const mkEl = (over = {}) => ({ click() {}, focus() {}, scrollIntoView() {}, dispatchEvent() {}, textContent: "hi", value: "v", ...over });
globalThis.document = { querySelector: (sel) => (sel && sel.includes("missing") ? null : mkEl()) };

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; console.log("PASS:", msg); } else { fail++; console.error("FAIL:", msg); } };

// ======================= frame-bridge =======================
{
  const posted = [];
  const parentWin = { postMessage: (msg, origin) => posted.push({ msg, origin }) };
  globalThis.parent = parentWin;

  const handle = FB.serve({
    allowedParentOrigins: ["http://host:4321"],
    tools: [
      ...FB.builtins,
      { name: "search_order", description: "查单", inputSchema: {}, execute: (i) => `订单 ${i && i.order_id || "?"}` },
    ],
  });

  const ready = posted.find((p) => p.msg && p.msg.event === "ready");
  assert(!!ready, "frame serve 主动发 ready");
  assert(ready && ready.origin === "http://host:4321", "ready targetOrigin = 首个白名单 origin");
  const names = ready && ready.msg.payload.tools.map((t) => t.name);
  assert(!!names && names.includes("click") && names.includes("get_value") && names.includes("search_order"), "ready 含内置+自定义工具");
  assert(!!ready && !ready.msg.payload.tools.some((t) => "execute" in t), "ready 不含 execute（执行留本地）");

  const frameHandler = listeners[listeners.length - 1];

  // 自定义工具执行
  let before = posted.length;
  await frameHandler({ origin: "http://host:4321", source: parentWin, data: { type: "ragframe_request", call_id: "c1", action: "search_order", input: { order_id: "X1" } } });
  let r = posted.slice(before).find((p) => p.msg.type === "ragframe_response");
  assert(r && r.msg.ok === true && r.msg.observation === "订单 X1", "自定义工具执行回 observation：" + (r && r.msg.observation));
  assert(r && r.origin === "http://host:4321", "response targetOrigin = event.origin（禁 *）");

  // builtins click
  before = posted.length;
  await frameHandler({ origin: "http://host:4321", source: parentWin, data: { type: "ragframe_request", call_id: "c2", action: "click", input: { selector: "#btn" } } });
  r = posted.slice(before).find((p) => p.msg.type === "ragframe_response");
  assert(r && r.msg.ok && r.msg.observation === "已点击 #btn", "builtins click 执行：" + (r && r.msg.observation));

  // 未注册工具
  before = posted.length;
  await frameHandler({ origin: "http://host:4321", source: parentWin, data: { type: "ragframe_request", call_id: "c3", action: "no_such", input: {} } });
  r = posted.slice(before).find((p) => p.msg.type === "ragframe_response");
  assert(r && r.msg.ok === false, "未注册工具返回 ok:false");

  // 白名单外静默忽略
  before = posted.length;
  await frameHandler({ origin: "http://evil", source: parentWin, data: { type: "ragframe_request", call_id: "c4", action: "search_order", input: {} } });
  assert(posted.length === before, "白名单外 origin 静默忽略（不回传）");

  handle.destroy();
}

// ======================= host-bridge =======================
{
  const sent = [];
  const frameContentWindow = { postMessage: (msg, origin) => sent.push({ msg, origin }) };
  const frameEl = { contentWindow: frameContentWindow };

  let toolsCb = null;
  const bridge = HB.connect({
    frame: frameEl,
    targetOrigin: "http://frame:5175",
    onTools: (tools) => { toolsCb = tools; },
  });

  const hello = sent.find((s) => s.msg && s.msg.event === "hello");
  assert(!!hello, "host connect 立即发 hello（触发 iframe 重发 ready）");
  assert(hello && hello.origin === "http://frame:5175", "hello targetOrigin = 配置 origin（禁 *）");

  const hostHandler = listeners[listeners.length - 1];

  // 收 ready → onTools
  hostHandler({
    origin: "http://frame:5175", source: frameContentWindow,
    data: { type: "ragframe_event", event: "ready", payload: { tools: [{ name: "click", description: "d", inputSchema: {} }] } },
  });
  assert(!!toolsCb && toolsCb.length === 1 && toolsCb[0].name === "click", "host 收 ready → onTools 回调（工具清单）");

  // call → 喂 response
  const p = bridge.call("click", { selector: "#x" });
  const req = sent.find((s) => s.msg && s.msg.type === "ragframe_request");
  assert(!!req, "host call 发 ragframe_request");
  hostHandler({ origin: "http://frame:5175", source: frameContentWindow, data: { type: "ragframe_response", call_id: req.msg.call_id, ok: true, observation: "已点击 #x" } });
  const result = await p;
  assert(result.ok === true && result.observation === "已点击 #x", "host call 拿到 response：" + JSON.stringify(result));

  // 白名单外/错 origin 的 response 被忽略
  const p2 = bridge.call("click", { selector: "#y" });
  const req2 = sent.filter((s) => s.msg && s.msg.type === "ragframe_request").pop();
  hostHandler({ origin: "http://evil", source: frameContentWindow, data: { type: "ragframe_response", call_id: req2.msg.call_id, ok: true, observation: "fake" } });
  // 错 origin 的 response 不应 resolve p2（仍 pending）
  let p2done = false;
  p2.then(() => { p2done = true; });
  await new Promise((res) => setTimeout(res, 50));
  assert(!p2done, "错 origin 的 response 被忽略（host 侧 origin 校验生效）");
  // 喂正确 response 让 p2 resolve，避免 unhandledRejection
  hostHandler({ origin: "http://frame:5175", source: frameContentWindow, data: { type: "ragframe_response", call_id: req2.msg.call_id, ok: true, observation: "ok" } });
  await p2;

  bridge.destroy();
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
