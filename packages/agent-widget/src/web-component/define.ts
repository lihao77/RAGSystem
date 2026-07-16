/**
 * widget Web Component 入口：注册 <rag-agent-widget> + 暴露 window.RagWidget.mount/unmount。
 *
 * 宿主页用法（任意框架/纯 HTML）：
 *   <script src="ragsystem-widget.umd.cjs"></script>
 *   <script>
 *     // 第三方嵌入：传 token（宿主服务端换取，仅用于 HTTP ticket 签发）
 *     // 内部嵌入：省略 token，走普通会话（后端零鉴权）
 *     RagWidget.mount({ backendBase: "https://api...", hostTools: [...] })
 *       .then(el => window._ragWidget = el);
 *   </script>
 *
 * 主题变量经 defineCustomElement styles 注入 Shadow DOM（:host 即 custom element，shadow 内生效）。
 * sessionId 省略时懒建：首次发送消息时 widget 内部建会话（有 token 走 POST /api/widget/sessions，无 token 走 /api/agent/sessions 零鉴权），避免加载即建空会话。
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
  addAttachment: (chip: { label: string; text: string; icon?: string }) => void;
  /** 直接发送一条消息。 */
  sendMessage: (text: string) => Promise<void>;
}

/** 宿主注入的自定义输入工具按钮（挂 widget 输入栏，如地图选点/框选/画线）。 */
export interface InputToolButton {
  id: string;
  /** 文字/emoji（纯文本渲染，非 v-html）；icon 缺省时的 fallback。 */
  label: string;
  /** 专业图标：SVG 字符串（stroke=currentColor，viewBox="0 0 24 24"），优先于 label 渲染。 */
  icon?: string;
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

/** UI 状态快照条目(随 user 消息进上下文;对齐 backend ui_context extension 的 entry 形态)。 */
export interface UiContextEntry {
  key: string;
  label?: string;
  value: string;
  detail?: string;
}

/** 宿主组件状态采集函数(发消息时调)。同步或异步;返回空数组=本条不带 ui_context。 */
export type UiStateProvider = () => UiContextEntry[] | Promise<UiContextEntry[]>;

/** mount 返回的元素句柄：HTMLElement + 运行时动态注册宿主工具（透出 client.registerTool）。 */
export interface RagWidgetHandle extends HTMLElement {
  /** 运行时动态注册宿主工具；返回注销函数。client 未连接时缓存，握手时一并 tools.register。 */
  registerHostTool: (spec: DelegatedToolSpec) => () => void;
  /** 注销已注册的宿主工具。 */
  unregisterHostTool: (name: string) => void;
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
  /** 浏览器嵌入使用的可公开 key；与 token 互斥。 */
  publishableKey?: string | undefined;
  /** 已有会话 id；省略则自动建。 */
  sessionId?: string;
  /** 宿主页注册的业务工具（agent 可委托执行）。 */
  hostTools?: DelegatedToolSpec[];
  /** 宿主自定义输入工具按钮（挂输入栏，如地图选点）。 */
  inputTools?: InputToolButton[];
  /** FAB 触发按钮位置（默认 {bottom:24,right:24} 右下）。 */
  fabPosition?: FabPosition;
  /**
   * 宿主组件状态采集函数（发消息时调，entries 随消息进上下文，agent 看得见宿主当前视图/选中/过滤）。
   * widget 是同源 custom element，直接调宿主函数；返回空数组则本条不带 ui_context。
   */
  uiState?: UiStateProvider;
  /**
   * 会话生命周期回调：session 创建（懒建首次发送）/ 切换（newSession）时通知宿主。
   * sid 非 null=新会话生效；null=旧会话已丢弃（宿主据此断开按 session 绑定的外部资源，如 MCP 执行端）。
   */
  onSessionChange?: (sessionId: string | null) => void;
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
export async function mount(options: RagWidgetMountOptions): Promise<RagWidgetHandle> {
  if (options.token && options.publishableKey) throw new Error("token 与 publishableKey 不能同时提供");
  const host = resolveHost(options);
  const el = document.createElement("rag-agent-widget") as RagWidgetHandle;
  const props = el as unknown as Record<string, unknown>;
  // customElement 的 props 经 DOM property 注入（defineProps 声明的属性）。
  props.backendBase = options.backendBase;
  // sessionId 省略=懒建：首次发送时 widget 内部 POST 建会话，避免一加载就建空会话。
  props.sessionId = options.sessionId;
  props.token = options.token;
  props.publishableKey = options.publishableKey;
  props.hostTools = options.hostTools ?? [];
  props.inputTools = options.inputTools ?? [];
  props.fabPosition = options.fabPosition ?? { bottom: 24, right: 24 };
  props.uiState = options.uiState;
  props.onSessionChange = options.onSessionChange;
  host.appendChild(el);
  return el;
}

/** 卸载 widget；不传则移除首个 rag-agent-widget。 */
export function unmount(el?: HTMLElement): void {
  const target = el ?? document.querySelector("rag-agent-widget");
  target?.remove();
}
