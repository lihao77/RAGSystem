/**
 * iframe 侧内置 DOM 工具集（完整声明：元数据 + execute）。
 *
 * frame-bridge.serve({ tools: [...RagFrameBridge.builtins, 自定义] }) 即启用；可按需裁剪。
 * execute 返回 observation 字符串；未命中/参数缺失抛 Error，框架捕获转 {ok:false,error}。
 * 不含任意 JS 执行（eval）——受限于安全模型。
 */
import type { FrameTool } from "./protocol.js";

/** 取必填字符串 selector，校验并 querySelector；未命中抛错。 */
function resolveElement(selector: unknown): Element {
  if (typeof selector !== "string" || selector === "") {
    throw new Error("selector 必填且为字符串");
  }
  const el = document.querySelector(selector);
  if (!el) throw new Error(`未找到元素: ${selector}`);
  return el;
}

/** 设值并派发 input+change，兼容受控组件（React/Vue 需走原生 setter 才触发）。 */
function fireInputEvents(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export const BUILTIN_TOOLS: FrameTool[] = [
  {
    name: "click",
    description: "点击 iframe 内匹配 selector 的元素。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS 选择器" } },
      required: ["selector"],
      additionalProperties: false,
    },
    riskLevel: "medium",
    execute: (input) => {
      const selector = (input as { selector?: string }).selector;
      const el = resolveElement(selector);
      (el as HTMLElement).click();
      return `已点击 ${selector}`;
    },
  },
  {
    name: "get_text",
    description: "读取 iframe 内匹配 selector 元素的文本内容（trim）。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS 选择器" } },
      required: ["selector"],
      additionalProperties: false,
    },
    riskLevel: "low",
    execute: (input) => {
      const selector = (input as { selector?: string }).selector;
      const el = resolveElement(selector);
      return (el.textContent ?? "").trim();
    },
  },
  {
    name: "get_value",
    description: "读取 iframe 内输入控件（input/textarea/select）的值。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS 选择器（input/textarea/select）" } },
      required: ["selector"],
      additionalProperties: false,
    },
    riskLevel: "low",
    execute: (input) => {
      const selector = (input as { selector?: string }).selector;
      const el = resolveElement(selector);
      if (
        !(el instanceof HTMLInputElement)
        && !(el instanceof HTMLTextAreaElement)
        && !(el instanceof HTMLSelectElement)
      ) {
        throw new Error(`元素不是可输入控件: ${selector}`);
      }
      return el.value;
    },
  },
  {
    name: "set_value",
    description: "设置 iframe 内输入控件的值（input/textarea/select，自动派发 input/change 兼容受控组件）。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS 选择器（input/textarea/select）" },
        value: { type: "string" },
      },
      required: ["selector", "value"],
      additionalProperties: false,
    },
    riskLevel: "medium",
    execute: (input) => {
      const { selector, value } = input as { selector?: string; value?: unknown };
      const el = resolveElement(selector);
      if (
        !(el instanceof HTMLInputElement)
        && !(el instanceof HTMLTextAreaElement)
        && !(el instanceof HTMLSelectElement)
      ) {
        throw new Error(`元素不是可输入控件: ${selector}`);
      }
      fireInputEvents(el, value == null ? "" : String(value));
      return `已设置 ${selector} = ${value == null ? "" : String(value)}`;
    },
  },
  {
    name: "scroll_to",
    description: "滚动到指定元素（selector）或坐标（x,y）。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS 选择器（与 x/y 二选一）" },
        x: { type: "number" },
        y: { type: "number" },
      },
      additionalProperties: false,
    },
    riskLevel: "low",
    execute: (input) => {
      const { selector, x, y } = input as { selector?: string; x?: number; y?: number };
      if (typeof selector === "string") {
        const el = resolveElement(selector);
        (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
        return `已滚动到 ${selector}`;
      }
      const nx = typeof x === "number" ? x : 0;
      const ny = typeof y === "number" ? y : 0;
      window.scrollTo(nx, ny);
      return `已滚动到 (${nx}, ${ny})`;
    },
  },
  {
    name: "focus",
    description: "聚焦 iframe 内匹配 selector 的元素。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS 选择器" } },
      required: ["selector"],
      additionalProperties: false,
    },
    riskLevel: "low",
    execute: (input) => {
      const selector = (input as { selector?: string }).selector;
      const el = resolveElement(selector);
      (el as HTMLElement).focus();
      return `已聚焦 ${selector}`;
    },
  },
  {
    name: "submit",
    description: "提交匹配 selector 的表单（优先 requestSubmit，触发 submit 事件）。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS 选择器（form 元素）" } },
      required: ["selector"],
      additionalProperties: false,
    },
    riskLevel: "medium",
    execute: (input) => {
      const selector = (input as { selector?: string }).selector;
      const el = resolveElement(selector);
      if (!(el instanceof HTMLFormElement)) throw new Error(`元素不是 form: ${selector}`);
      if (typeof el.requestSubmit === "function") el.requestSubmit();
      else el.submit();
      return `已提交表单 ${selector}`;
    },
  },
];
