/**
 * widget Web Component 入口：注册 <rag-agent-widget> + 暴露 window.RagWidget.mount/unmount。
 *
 * 宿主页用法（任意框架/纯 HTML）：
 *   <script src="ragsystem-widget.umd.cjs"></script>
 *   <script>
 *     // 第三方嵌入：传 token（宿主服务端换取，widgetAuth 受约束会话）
 *     // 内部嵌入：省略 token，走普通会话（后端零鉴权）
 *     RagWidget.mount({ backendBase: "https://api...", hostTools: [...] })
 *       .then(el => window._ragWidget = el);
 *   </script>
 *
 * 主题变量经 defineCustomElement styles 注入 Shadow DOM（:host 即 custom element，shadow 内生效）。
 * sessionId 省略时自动建会话：有 token 走 POST /api/widget/sessions（Bearer），无 token 走 POST /api/agent/sessions（零鉴权）。
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

/** onClick 回调注入的输入操纵 API（widget 暴露给宿主按钮）。 */
export interface WidgetInputApi {
  /** 预填输入框文本（不发送）。 */
  setDraft: (text: string) => void;
  /** 加一个 chip（坐标等整体单元），显示为不可拆分胶囊，×整体删；发送时 text 和输入文字拼一起。 */
  addAttachment: (chip: { label: string; text: string }) => void;
  /** 直接发送一条消息。 */
  sendMessage: (text: string) => Promise<void>;
}

/** 宿主注入的自定义输入工具按钮（挂 widget 输入栏，如地图选点/框选/画线）。 */
export interface InputToolButton {
  id: string;
  /** 按钮文字/emoji（纯文本渲染，非 v-html）。 */
  label: string;
  /** tooltip / aria-label。 */
  title?: string;
  /** 点击回调；宿主在此启动地图选点等交互，完成后调 setDraft 预填或 sendMessage 直接发。 */
  onClick: (api: WidgetInputApi) => void | Promise<void>;
}

/** FAB 触发按钮位置（宿主配置；未传字段为 auto，默认 bottom:24 right:24）。 */
export interface FabPosition {
  top?: number | string;
  right?: number | string;
  bottom?: number | string;
  left?: number | string;
}

export interface RagWidgetMountOptions {
  /** 挂载点（选择器或元素）；省略则挂 body 末尾。 */
  el?: string | HTMLElement;
  /** 后端 origin，如 https://api.host.com。 */
  backendBase: string;
  /**
   * 嵌入方服务端换来的短时 JWT（可选）。省略=内部普通会话（零鉴权，由 widget 直接建普通 session）。
   */
  token?: string | undefined;
  /** 已有会话 id；省略则自动建。 */
  sessionId?: string;
  /** 宿主页注册的业务工具（agent 可委托执行）。 */
  hostTools?: DelegatedToolSpec[];
  /** 宿主自定义输入工具按钮（挂输入栏，如地图选点）。 */
  inputTools?: InputToolButton[];
  /** FAB 触发按钮位置（默认 {bottom:24,right:24} 右下）。 */
  fabPosition?: FabPosition;
}

async function ensureSession(options: RagWidgetMountOptions): Promise<string> {
  if (options.sessionId) {
    return options.sessionId;
  }
  const base = options.backendBase.replace(/\/$/, "");
  // 有 token：走 widgetAuth 受约束会话（第三方嵌入）；无 token：走普通会话（内部场景，后端零鉴权）。
  // 两端点返回结构一致（{ data: { session_id } }），仅端点与鉴权头不同。
  const res = options.token
    ? await fetch(`${base}/api/widget/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify({ host_tools: (options.hostTools ?? []).map((tool) => tool.name) }),
      })
    : await fetch(`${base}/api/agent/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
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
  props.inputTools = options.inputTools ?? [];
  props.fabPosition = options.fabPosition ?? { bottom: 24, right: 24 };
  host.appendChild(el);
  return el;
}

/** 卸载 widget；不传则移除首个 rag-agent-widget。 */
export function unmount(el?: HTMLElement): void {
  const target = el ?? document.querySelector("rag-agent-widget");
  target?.remove();
}
