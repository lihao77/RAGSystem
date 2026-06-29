/**
 * widget Web Component 入口：注册 <rag-agent-widget> + 暴露 window.RagWidget.mount/unmount。
 *
 * 宿主页用法（任意框架/纯 HTML）：
 *   <script src="ragsystem-widget.umd.cjs"></script>
 *   <script>
 *     RagWidget.mount({ backendBase: "https://api...", token: "<jwt>", hostTools: [...] })
 *       .then(el => window._ragWidget = el);
 *   </script>
 *
 * 主题变量经 defineCustomElement styles 注入 Shadow DOM（:host 即 custom element，shadow 内生效）。
 * sessionId 省略时自动 POST /api/widget/sessions（Bearer token）建会话。
 */
import { defineCustomElement } from "vue";
import type { DelegatedToolSpec } from "@ragsystem/agent-protocol";

import ChatPanel from "../components/ChatPanel.vue";
// ?inline 让 vite 返回 CSS 字符串，经 defineCustomElement styles 注入 shadow root
import themeCss from "../styles/theme.css?inline";

// customElement 模式下子组件 scoped CSS 不自动进 shadow root，用 ?raw 读 .vue 源码提取 <style>，
// 去掉 :deep() 包装（shadow 内已隔离，无需 scoped），连同 theme 注入 shadow root。
const vueSources = import.meta.glob("../components/**/*.vue", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const componentStyles = Object.values(vueSources)
  .map((src) => {
    const blocks: string[] = [];
    const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      blocks.push(m[1] ?? "");
    }
    return blocks.join("\n").replace(/:deep\(([^)]+)\)/g, "$1");
  })
  .filter(Boolean);

const RagWidgetElement = defineCustomElement(ChatPanel, {
  styles: [themeCss, ...componentStyles],
});

if (typeof customElements !== "undefined" && !customElements.get("rag-agent-widget")) {
  customElements.define("rag-agent-widget", RagWidgetElement);
}

export interface RagWidgetMountOptions {
  /** 挂载点（选择器或元素）；省略则挂 body 末尾。 */
  el?: string | HTMLElement;
  /** 后端 origin，如 https://api.host.com。 */
  backendBase: string;
  /** 嵌入方服务端换来的短时 JWT。 */
  token: string;
  /** 已有会话 id；省略则自动建。 */
  sessionId?: string;
  /** 宿主页注册的业务工具（agent 可委托执行）。 */
  hostTools?: DelegatedToolSpec[];
}

async function ensureSession(options: RagWidgetMountOptions): Promise<string> {
  if (options.sessionId) {
    return options.sessionId;
  }
  const base = options.backendBase.replace(/\/$/, "");
  const res = await fetch(`${base}/api/widget/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.token}`,
    },
    body: JSON.stringify({ host_tools: (options.hostTools ?? []).map((tool) => tool.name) }),
  });
  if (!res.ok) {
    throw new Error(`widget 会话创建失败: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as { data?: { session_id?: string } };
  const sessionId = json.data?.session_id;
  if (!sessionId) {
    throw new Error("widget 会话创建失败: 响应缺 session_id");
  }
  return sessionId;
}

function resolveHost(options: RagWidgetMountOptions): HTMLElement {
  if (!options.el) {
    return document.body;
  }
  if (typeof options.el === "string") {
    const found = document.querySelector(options.el);
    if (!found) {
      throw new Error(`widget 挂载点未找到: ${options.el}`);
    }
    return found as HTMLElement;
  }
  return options.el;
}

/** 挂载 widget；返回创建的 <rag-agent-widget> 元素。 */
export async function mount(options: RagWidgetMountOptions): Promise<HTMLElement> {
  const sessionId = await ensureSession(options);
  const host = resolveHost(options);
  const el = document.createElement("rag-agent-widget");
  const props = el as unknown as Record<string, unknown>;
  // customElement 的 props 经 DOM property 注入（defineProps 声明的属性）。
  props.backendBase = options.backendBase;
  props.sessionId = sessionId;
  props.token = options.token;
  props.hostTools = options.hostTools ?? [];
  host.appendChild(el);
  return el;
}

/** 卸载 widget；不传则移除首个 rag-agent-widget。 */
export function unmount(el?: HTMLElement): void {
  const target = el ?? document.querySelector("rag-agent-widget");
  target?.remove();
}
