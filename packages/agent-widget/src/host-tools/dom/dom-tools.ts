/**
 * DOM 工具共享纯函数（document-agnostic）：跨"主页面 / 同源 iframe / 跨源 iframe"复用。
 *
 * - host-tools/dom/bind.bindDomTools 闭包主页面或同源 iframe 的 document（直接操作，零侵入 iframe）
 * - host-tools/dom/builtins 闭包 iframe 自己的 document（经 frame-bridge postMessage 触发，跨源唯一解）
 * - inspectDoc 同理三处复用（bind 的 inspect_state / frame-bridge __inspect__ / connectFrames host.inspect）
 *
 * 工具声明（name/description/inputSchema/riskLevel）+ run(doc, input) 纯函数；不持有 document。
 * 不含任意 JS 执行（eval）——受限于安全模型。
 */

import type { ToolResult } from "@ragsystem/agent-protocol";
import type { HostToolDeclaration } from "../types.js";

/** DOM 工具声明 + document-agnostic 执行函数。 */
export interface DomToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel: "low" | "medium" | "high";
  /** 对 doc 执行；返回 observation 字符串；未命中/参数缺失抛 Error（框架捕获转 {ok:false,error}）。 */
  run: (doc: Document, input: unknown) => string | Promise<string>;
}

/** 取必填字符串 selector，校验并 querySelector；未命中抛错。 */
function resolveElement(doc: Document, selector: unknown): Element {
  if (typeof selector !== "string" || selector === "") {
    throw new Error("selector 必填且为字符串");
  }
  const el = doc.querySelector(selector);
  if (!el) throw new Error(`未找到元素: ${selector}`);
  return el;
}

/** 设值并派发 input+change，兼容受控组件（React/Vue 需走原生 setter 才触发）。 */
function fireInputEvents(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
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

/** 内置 DOM 操作工具集（不含 inspect；inspect 走 inspectDoc）。description 通用化（去 iframe 字样）。 */
export const DOM_TOOLS: DomToolSpec[] = [
  {
    name: "click",
    description: "点击匹配 selector 的元素。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS 选择器" } },
      required: ["selector"],
      additionalProperties: false,
    },
    riskLevel: "medium",
    run: (doc, input) => {
      const selector = (input as { selector?: string }).selector;
      const el = resolveElement(doc, selector);
      (el as HTMLElement).click();
      return `已点击 ${selector}`;
    },
  },
  {
    name: "get_text",
    description: "读取匹配 selector 元素的文本内容（trim）。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS 选择器" } },
      required: ["selector"],
      additionalProperties: false,
    },
    riskLevel: "low",
    run: (doc, input) => {
      const selector = (input as { selector?: string }).selector;
      const el = resolveElement(doc, selector);
      return (el.textContent ?? "").trim();
    },
  },
  {
    name: "get_value",
    description: "读取输入控件（input/textarea/select）的值。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS 选择器（input/textarea/select）" } },
      required: ["selector"],
      additionalProperties: false,
    },
    riskLevel: "low",
    run: (doc, input) => {
      const selector = (input as { selector?: string }).selector;
      const el = resolveElement(doc, selector);
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
    description: "设置输入控件的值（input/textarea/select，自动派发 input/change 兼容受控组件）。",
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
    run: (doc, input) => {
      const { selector, value } = input as { selector?: string; value?: unknown };
      const el = resolveElement(doc, selector);
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
    run: (doc, input) => {
      const { selector, x, y } = input as { selector?: string; x?: number; y?: number };
      if (typeof selector === "string") {
        const el = resolveElement(doc, selector);
        (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
        return `已滚动到 ${selector}`;
      }
      const nx = typeof x === "number" ? x : 0;
      const ny = typeof y === "number" ? y : 0;
      doc.defaultView?.scrollTo(nx, ny);
      return `已滚动到 (${nx}, ${ny})`;
    },
  },
  {
    name: "focus",
    description: "聚焦匹配 selector 的元素。",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "CSS 选择器" } },
      required: ["selector"],
      additionalProperties: false,
    },
    riskLevel: "low",
    run: (doc, input) => {
      const selector = (input as { selector?: string }).selector;
      const el = resolveElement(doc, selector);
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
    run: (doc, input) => {
      const selector = (input as { selector?: string }).selector;
      const el = resolveElement(doc, selector);
      if (!(el instanceof HTMLFormElement)) throw new Error(`元素不是 form: ${selector}`);
      if (typeof el.requestSubmit === "function") el.requestSubmit();
      else el.submit();
      return `已提交表单 ${selector}`;
    },
  },
];

/** selector 生成：优先 #id，否则 tag:nth-of-type。 */
function nthSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  if (sameTag.length === 1) return tag;
  const idx = sameTag.indexOf(el) + 1;
  return `${tag}:nth-of-type(${idx})`;
}

/**
 * 深度探测：扫 doc 可交互元素，生成 `tag[type][selector] =值/"标签"` 清单。
 * 覆盖 input/textarea/select/button/a[href]/[role=button]；截断 50 项防 token 爆炸。
 */
export function inspectDoc(doc: Document): string {
  const MAX = 50;
  const els = doc.querySelectorAll("input, textarea, select, button, a[href], [role='button']");
  const lines: string[] = [];
  for (const el of els) {
    if (lines.length >= MAX) break;
    const tag = el.tagName.toLowerCase();
    const sel = el.id ? `#${el.id}` : nthSelector(el);
    const type = el.getAttribute("type") || el.getAttribute("role") || "";
    const valueAttr = (el as HTMLInputElement).value;
    const value = typeof valueAttr === "string" && valueAttr ? valueAttr : "";
    const label = (el.textContent || "").trim();
    const desc = value ? `="${value.slice(0, 40)}"` : label ? `="${label.slice(0, 40)}"` : "";
    lines.push(`${tag}${type ? `/${type}` : ""}[${sel}]${desc}`);
  }
  const suffix = els.length > MAX ? `\n…（共 ${els.length} 项，截断 ${MAX}）` : "";
  return lines.join("\n") + suffix;
}

/**
 * 把 DOM_TOOLS 转成 HostToolDeclaration[]，闭包指定 document。
 * 主网页 bind 与 iframe builtins 共用此转换——同一份工具定义两用（直接注册 / 经 bridge 传递）。
 */
export function domToolsToHostSpecs(doc: Document): HostToolDeclaration[] {
  return DOM_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    riskLevel: t.riskLevel,
    execute: async (input): Promise<ToolResult> => {
      try {
        const obs = await t.run(doc, input);
        return { ok: true, observation: String(obs ?? "") };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { ok: false, observation: error, error };
      }
    },
  }));
}
