/**
 * 前端 Message Extension 渲染子系统——与 backend 投影子系统(context/extensions/)解耦。
 *
 * RENDERERS:kind → { component(异步组件), slot }。ChatMessageItem 遍历 extensions 按 slot 编排
 * (above:content 上方 / below:下方 / replace:整条替换)。
 * normalizeExtensions:读 metadata.extensions[](写入侧 backend 已统一落 extensions,纯透传)。
 *
 * attachments 不单独走 renderer——消息加载时从统一 extension 派生 msg.attachments，
 * 沿用 UserMessage 现有附件展示与编辑交互。
 *
 * 注:command_result/command 是消息类型(role + metadata.msg_type 分派,见 ChatMessageItem);
 * background_notification 走 metadata.source——都不是消息的内容伴随,不进 extensions[]。
 */
import { defineAsyncComponent } from 'vue';
import { normalizeSessionAttachment } from './sessionAttachments.js';

export const RENDERERS = {
  ui_context: {
    component: defineAsyncComponent(() => import('../components/chat/extensions/UiContextExt.vue')),
    slot: 'above',
  },
};

/** 读侧归一:metadata.extensions[] 优先,否则空数组(写入侧 backend 已统一,不读老 attachments)。 */
export function normalizeExtensions(metadata) {
  const md = metadata || {};
  return Array.isArray(md.extensions) && md.extensions.length ? md.extensions : [];
}

/** 取消息的归一化 extensions(渲染前)。 */
export function getMessageExtensions(msg) {
  return normalizeExtensions(msg?.metadata);
}

export function createAttachmentsExtension(attachments) {
  const items = (attachments || []).map((attachment) => ({
    file_id: attachment.file_id,
    original_name: attachment.original_name || attachment.stored_name,
    stored_name: attachment.stored_name || attachment.original_name,
    mime: attachment.mime || '',
    size: Number(attachment.size || 0),
    kind: attachment.kind === 'image' ? 'image' : 'file',
  })).filter((attachment) => attachment.file_id && attachment.original_name && attachment.stored_name);
  return items.length ? { kind: 'attachments', version: 1, data: { items } } : null;
}

export function getMessageAttachments(metadata) {
  const extension = normalizeExtensions(metadata).find((item) => item?.kind === 'attachments' && item?.version === 1);
  const items = Array.isArray(extension?.data?.items) ? extension.data.items : [];
  return items.map(normalizeSessionAttachment).filter(Boolean);
}
