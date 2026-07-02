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
const mkEl = (over = {}) => ({ tagName: "DIV", id: "", click() {}, focus() {}, scrollIntoView() {}, dispatchEvent() {}, getAttribute: () => null, parentElement: null, textContent: "hi", value: "v", ...over });
const mockEls = [
  { tagName: "INPUT", id: "order-input", value: "ORD-123", getAttribute: () => null, parentElement: null, textContent: "" },
  { tagName: "BUTTON", id: "submit-btn", value: undefined, getAttribute: () => null, parentElement: null, textContent: "提交" },
];
globalThis.document = {
  querySelector: (sel) => (sel && sel.includes("missing") ? null : mkEl()),
  querySelectorAll: () => mockEls,
};

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

  // __inspect__ 内部 action（builtinInspect 扫 DOM 元素清单）
  before = posted.length;
  await frameHandler({ origin: "http://host:4321", source: parentWin, data: { type: "ragframe_request", call_id: "c-ins", action: "__inspect__", input: null } });
  r = posted.slice(before).find((p) => p.msg.type === "ragframe_response");
  assert(r && r.msg.ok && r.msg.observation.includes("input[#order-input]") && r.msg.observation.includes("ORD-123") && r.msg.observation.includes("button[#submit-btn]"), "frame __inspect__ 内置扫 DOM：" + (r && r.msg.observation));

  // 自定义 inspect 覆盖内置
  const savedParent = globalThis.parent;
  const posted2 = [];
  const parentWin2 = { postMessage: (msg, origin) => posted2.push({ msg, origin }) };
  globalThis.parent = parentWin2;
  FB.serve({ allowedParentOrigins: ["http://h2"], tools: [], inspect: () => "自定义状态：页面X，2 个表单" });
  const h2 = listeners[listeners.length - 1];
  await h2({ origin: "http://h2", source: parentWin2, data: { type: "ragframe_request", call_id: "ci2", action: "__inspect__", input: null } });
  const r2i = posted2.find((p) => p.msg.type === "ragframe_response");
  assert(r2i && r2i.msg.observation === "自定义状态：页面X，2 个表单", "frame 自定义 inspect 覆盖内置");
  globalThis.parent = savedParent;

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

// ======================= connectFrames（多 iframe 激活切换）=======================
{
  listeners.length = 0; // 隔离前面段
  const registered = new Map(); // widgetEl 当前注册的工具（name → {spec, unsub}）
  const widgetEl = {
    registerHostTool(spec) {
      if (registered.has(spec.name)) { try { registered.get(spec.name).unsub(); } catch {} }
      const unsub = () => { registered.delete(spec.name); };
      registered.set(spec.name, { spec, unsub });
      return unsub;
    },
    unregisterHostTool(name) { if (registered.has(name)) registered.get(name).unsub(); },
  };
  const sent1 = []; const sent2 = [];
  const win1 = { postMessage: (msg, origin) => sent1.push({ msg, origin }) };
  const win2 = { postMessage: (msg, origin) => sent2.push({ msg, origin }) };
  const frames = [
    { id: "b1", frame: { contentWindow: win1 }, targetOrigin: "http://b1", label: "系统 B1" },
    { id: "b2", frame: { contentWindow: win2 }, targetOrigin: "http://b2", label: "系统 B2" },
  ];
  let activeChanged = null;
  const mgr = HB.connectFrames({ widgetEl, frames, activeId: "b1", onActiveChange: (id) => { activeChanged = id; }, host: { inspect: () => "主页面状态：海洋监测视图" } });

  assert(registered.has("list_frames") && registered.has("switch_frame") && registered.has("inspect_state"), "connectFrames 注册常驻 list_frames/switch_frame/inspect_state");

  // 模拟 message：对所有 listener 喂（每个 connect handler 按 source/origin 自行过滤）
  const feed = (source, origin, data) => { for (const h of listeners) h({ origin, source, data }); };
  const feedAll = (source, origin, tools) => feed(source, origin, { type: "ragframe_event", event: "ready", payload: { tools } });

  feedAll(win1, "http://b1", [{ name: "click", description: "点击", inputSchema: {} }, { name: "search", description: "搜", inputSchema: {} }]);
  assert(registered.has("click") && registered.has("search"), "active(b1) ready → 注册 b1 工具 click/search");

  feedAll(win2, "http://b2", [{ name: "submit", description: "提交", inputSchema: {} }, { name: "get_text", description: "读", inputSchema: {} }]);
  assert(!registered.has("submit"), "非 active(b2) ready → 不注册其工具");

  // 用户切换路径：setActive
  activeChanged = null;
  mgr.setActive("b2");
  assert(!registered.has("click") && !registered.has("search"), "用户 setActive(b2) → 旧 active 工具注销");
  assert(registered.has("submit") && registered.has("get_text"), "setActive(b2) → 新 active 工具注册");
  assert(activeChanged === "b2", "setActive 触发 onActiveChange(b2)");

  // agent 切换路径：switch_frame 工具
  activeChanged = null;
  const sw = registered.get("switch_frame").spec;
  const r = await sw.execute({ frame_id: "b1" });
  assert(registered.has("click") && !registered.has("submit"), "agent switch_frame(b1) → 工具切回 b1");
  assert(activeChanged === "b1", "switch_frame 也触发 onActiveChange（双路径合一）");
  assert(r.ok && r.observation.includes("系统 B1"), "switch_frame 返回含 label");

  // 未知 frame_id
  const r2 = await sw.execute({ frame_id: "nope" });
  assert(r2.ok === false, "switch_frame 未知 frame_id → ok:false");

  // list_frames
  const lf = registered.get("list_frames").spec;
  const rl = await lf.execute({});
  const parsed = JSON.parse(rl.observation);
  assert(parsed.length === 2 && parsed.find((x) => x.id === "b1").active, "list_frames 返回 2 frame，b1 active");

  // inspect_state：默认 active(b1) → callInspect
  const isp = registered.get("inspect_state").spec;
  const pIsp = isp.execute({});
  const inspectReq = sent1.find((s) => s.msg.action === "__inspect__");
  assert(!!inspectReq, "inspect_state 默认 → 向 active(b1) 发 __inspect__");
  feed(win1, "http://b1", { type: "ragframe_response", call_id: inspectReq.msg.call_id, ok: true, observation: "input[#x]" });
  const rIsp = await pIsp;
  assert(rIsp.ok && rIsp.observation === "input[#x]", "inspect_state 返回 active 的 inspect 结果");

  // inspect_state host 源
  const rHost = await isp.execute({ source_id: "host" });
  assert(rHost.ok && rHost.observation === "主页面状态：海洋监测视图", "inspect_state source_id=host → host.inspect");

  // 未知 source_id
  const rBad = await isp.execute({ source_id: "nope" });
  assert(rBad.ok === false, "inspect_state 未知 source_id → ok:false");

  mgr.destroy();
  assert(!registered.has("list_frames"), "destroy 注销管理工具");
}

// ======================= bindDomTools（主页面/同源 iframe 直接操作 document）=======================
{
  const clickEl = { tagName: "BUTTON", id: "btn", textContent: "提交", clicked: false, click() { this.clicked = true; }, getAttribute: () => null, value: undefined };
  const inputEl = { tagName: "INPUT", id: "inp", value: "ORD-1", getAttribute: () => null, dispatchEvent() {}, textContent: "" };
  const mockDoc = {
    querySelector: (sel) => (sel === "#btn" ? clickEl : sel === "#inp" ? inputEl : null),
    querySelectorAll: () => [clickEl, inputEl],
  };
  const registered = new Map();
  const widgetEl = {
    registerHostTool(spec) {
      if (registered.has(spec.name)) { try { registered.get(spec.name).unsub(); } catch {} }
      const unsub = () => { registered.delete(spec.name); };
      registered.set(spec.name, { spec, unsub });
      return unsub;
    },
    unregisterHostTool(name) { if (registered.has(name)) registered.get(name).unsub(); },
  };

  const unbind = HB.bindDomTools({ widgetEl, document: mockDoc });
  assert(["click", "get_text", "get_value", "set_value", "scroll_to", "focus", "submit", "inspect_state"].every((n) => registered.has(n)), "bindDomTools 注册全部 DOM 工具 + inspect_state");

  const clickSpec = registered.get("click").spec;
  const rClick = await clickSpec.execute({ selector: "#btn" });
  assert(rClick.ok && rClick.observation === "已点击 #btn" && clickEl.clicked, "bindDomTools click 操作传入 doc（dom-tools 纯函数）：" + JSON.stringify(rClick));

  const inspSpec = registered.get("inspect_state").spec;
  const rIns = await inspSpec.execute({});
  assert(rIns.ok && rIns.observation.includes("button[#btn]") && rIns.observation.includes("input[#inp]"), "bindDomTools inspect_state 扫传入 doc：" + (rIns && rIns.observation));

  const rMiss = await clickSpec.execute({ selector: "#missing" });
  assert(rMiss.ok === false && rMiss.error.includes("未找到"), "bindDomTools selector 未命中 → ok:false：" + JSON.stringify(rMiss));

  unbind();
  assert(!registered.has("click") && !registered.has("inspect_state"), "bindDomTools unbind 注销全部");
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail > 0 ? 1 : 0);
