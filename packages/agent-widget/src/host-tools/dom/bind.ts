/**
 * 主页面（或同源 iframe）DOM 工具集注册——无 iframe 主场景开箱即用。
 *
 * 复用 domToolsToHostSpecs 把 DOM_TOOLS 转成 HostToolDeclaration[]（与 iframe builtins 同源转换），
 * 循环 registerHostTool 注册给 widget；再注册 inspect_state。
 *
 * document 缺省=主页面 document；传同源 iframe 的 contentDocument 即控制该 iframe
 * （零侵入，不需 frame-bridge）。跨源 iframe 必须走 frame-bridge（同源策略）。
 *
 * 注意：与 connectFrames 的 inspect_state 同名，宿主按场景二选一（无 iframe 用本函数 / 多 iframe 用 connectFrames）。
 * 返回 unbind：注销全部。
 */
import type { HostToolRegistrar } from "@ragsystem/agent-protocol";
import { domToolsToHostSpecs, inspectDoc } from "./dom-tools.js";

export function bindDomTools(widgetEl: HostToolRegistrar, doc?: Document): () => void {
  const hostDoc = doc ?? (typeof document !== "undefined" ? document : null);
  if (!hostDoc) throw new Error("bindDomTools: document 不可用（显式传 document 参数）");
  const unsubs: Array<() => void> = [];
  for (const spec of domToolsToHostSpecs(hostDoc)) {
    unsubs.push(widgetEl.registerHostTool(spec));
  }
  unsubs.push(
    widgetEl.registerHostTool({
      name: "inspect_state",
      description: "深度探测当前页面的可交互元素清单（selector + 类型 + 当前值/标签）。操作前调此工具看页面有什么可操作元素、selector 是什么。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      riskLevel: "low",
      execute: async () => ({ ok: true, observation: inspectDoc(hostDoc) }),
    }),
  );
  return () => {
    for (const u of unsubs) {
      try { u(); } catch {}
    }
  };
}
