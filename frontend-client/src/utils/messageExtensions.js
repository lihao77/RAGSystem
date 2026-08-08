/**
 * 前端 Message Extension 渲染子系统——与 backend 投影子系统(context/extensions/)解耦。
 *
 * RENDERERS:kind → { component(异步组件), slot }。ChatMessageItem 遍历 extensions 按 slot 编排。
 * normalizeExtensions:读 metadata.extensions[](写入侧 backend 已统一落 extensions,纯透传)。
 *
 * command_ref/command_result 属于规范 content_parts；background_notification 仍走 metadata.source。
 */
import { defineAsyncComponent } from 'vue';

export const RENDERERS = {
  ui_context: {
    component: defineAsyncComponent(() => import('../components/chat/extensions/UiContextExt.vue')),
    slot: 'above',
  },
};

/** 读取正文之外的 metadata extensions；附件和文件引用只存在于 content_parts。 */
export function normalizeExtensions(metadata) {
  const md = metadata || {};
  return Array.isArray(md.extensions) && md.extensions.length ? md.extensions : [];
}

/** 取消息的归一化 extensions(渲染前)。 */
export function getMessageExtensions(msg) {
  return normalizeExtensions(msg?.metadata);
}
