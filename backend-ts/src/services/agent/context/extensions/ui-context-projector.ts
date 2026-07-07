/**
 * ui_context projector——把前端组件状态快照序列化成 <ui_context> 文本块。
 * entries 摘要级(value 必填字符串),空则不投影(null)。
 * 投影文本追加到 user content 末尾(走 user role,不进 system 缓存段,cache 安全)。
 */
import type { ExtensionProjector } from "./types.js";

interface UiContextEntry {
  label?: string;
  value?: string;
  detail?: string;
}

/** 把 ui_context data 序列化为 <ui_context> 文本块;空返回空串。纯函数,前端/测试可复用。 */
export function renderUiContextText(data: Record<string, unknown> | undefined): string {
  const entries = data?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return "";
  const lines = entries
    .filter((e): e is UiContextEntry =>
      typeof e === "object" && e !== null && typeof (e as { value?: unknown }).value === "string",
    )
    .map((e) => {
      const label = typeof e.label === "string" ? e.label : "";
      const detail = typeof e.detail === "string" && e.detail ? `(${e.detail})` : "";
      return `- ${label}: ${e.value}${detail}`;
    });
  return lines.length ? `<ui_context>\n${lines.join("\n")}\n</ui_context>` : "";
}

export const uiContextProjector: ExtensionProjector = {
  kind: "ui_context",
  project(data) {
    const text = renderUiContextText(data);
    return text || null;
  },
};
