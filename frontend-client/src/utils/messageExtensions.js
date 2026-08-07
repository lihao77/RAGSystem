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
  rich_content: {
    component: defineAsyncComponent(() => import('../components/chat/extensions/RichContentExt.vue')),
    slot: 'replace',
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

export function getRichContentExtension(msg) {
  return getMessageExtensions(msg).find(
    item => item?.kind === 'rich_content' && item?.version === 1 && Array.isArray(item?.data?.parts),
  ) || null;
}

export function getMessageFileRefs(msg) {
  const parts = getRichContentExtension(msg)?.data?.parts || [];
  return parts.filter(part => part?.type === 'file_ref' && typeof part.file_path === 'string' && part.file_path);
}

export function applyRichContentPart(msg, partIndex, part) {
  if (!msg || !Number.isSafeInteger(partIndex) || partIndex < 0 || !part) return;
  const parts = ensureRichContentParts(msg, partIndex);
  if (part.type === 'file_ref') {
    parts[partIndex] = {
      type: 'file_ref',
      file_path: String(part.file_path || ''),
      presentation: ['inline', 'attachment', 'preview'].includes(part.presentation) ? part.presentation : 'attachment',
      ...(part.caption ? { caption: String(part.caption) } : {}),
    };
  }
}

export function applyRichContentTextDelta(msg, partIndex, delta) {
  const extension = getRichContentExtension(msg);
  if (!extension || !Number.isSafeInteger(partIndex) || partIndex < 0 || !delta) return;
  const parts = extension.data.parts;
  const existing = parts[partIndex];
  if (existing?.type === 'text') existing.text += delta;
  else parts[partIndex] = { type: 'text', text: delta };
}

export function reconcileRichContent(msg, contentParts) {
  if (!msg) return;
  const parts = Array.isArray(contentParts) ? contentParts.filter(isContentPart) : [];
  const extensions = getMessageExtensions(msg).filter(item => item?.kind !== 'rich_content');
  if (parts.some(part => part.type === 'file_ref')) {
    extensions.push({ kind: 'rich_content', version: 1, slot: 'replace', data: { parts } });
  }
  msg.metadata = { ...(msg.metadata || {}), extensions };
}

function ensureRichContentParts(msg, targetIndex) {
  let extension = getRichContentExtension(msg);
  if (!extension) {
    const extensions = getMessageExtensions(msg).filter(item => item?.kind !== 'rich_content');
    const parts = [];
    if (targetIndex > 0 && msg.content) parts[0] = { type: 'text', text: msg.content };
    extension = { kind: 'rich_content', version: 1, slot: 'replace', data: { parts } };
    msg.metadata = { ...(msg.metadata || {}), extensions: [...extensions, extension] };
  }
  return extension.data.parts;
}

function isContentPart(part) {
  if (part?.type === 'text') return typeof part.text === 'string';
  return part?.type === 'file_ref'
    && typeof part.file_path === 'string'
    && part.file_path
    && ['inline', 'attachment', 'preview'].includes(part.presentation);
}
