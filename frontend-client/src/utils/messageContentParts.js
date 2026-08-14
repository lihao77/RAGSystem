import { normalizeSessionAttachment } from './sessionAttachments.js';

const FILE_PRESENTATIONS = new Set(['inline', 'attachment', 'preview']);

export function normalizeMessageContentParts(parts) {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') {
      return [{ type: 'text', text: part.text }];
    }
    if (part?.type === 'file_ref'
      && typeof part.file_path === 'string'
      && part.file_path
      && FILE_PRESENTATIONS.has(part.presentation)) {
      return [{
        type: 'file_ref',
        file_path: part.file_path,
        presentation: part.presentation,
        ...(typeof part.caption === 'string' && part.caption ? { caption: part.caption } : {}),
        ...(typeof part.media_type === 'string' && part.media_type ? { media_type: part.media_type } : {}),
        ...(Number.isSafeInteger(part.size) && part.size >= 0 ? { size: part.size } : {}),
      }];
    }
    if (part?.type === 'attachment_ref'
      && typeof part.file_id === 'string'
      && part.file_id
      && typeof part.original_name === 'string'
      && part.original_name
      && typeof part.stored_name === 'string'
      && part.stored_name) {
      return [{
        type: 'attachment_ref',
        file_id: part.file_id,
        original_name: part.original_name,
        stored_name: part.stored_name,
        mime: typeof part.mime === 'string' ? part.mime : '',
        size: Number.isSafeInteger(part.size) && part.size >= 0 ? part.size : 0,
        kind: part.kind === 'image' ? 'image' : 'file',
        presentation: FILE_PRESENTATIONS.has(part.presentation)
          ? part.presentation
          : (part.kind === 'image' ? 'inline' : 'attachment'),
        ...(typeof part.file_path === 'string' && part.file_path ? { file_path: part.file_path } : {}),
        ...(['uploads', 'absolute'].includes(part.file_path_space) ? { file_path_space: part.file_path_space } : {}),
      }];
    }
    if (part?.type === 'image_description'
      && typeof part.file_id === 'string'
      && part.file_id
      && typeof part.original_name === 'string'
      && part.original_name
      && typeof part.text === 'string') {
      return [{
        type: 'image_description',
        file_id: part.file_id,
        original_name: part.original_name,
        text: part.text,
      }];
    }
    if (part?.type === 'command_ref'
      && typeof part.invocation_id === 'string'
      && part.invocation_id
      && typeof part.name === 'string'
      && part.name
      && typeof part.args === 'string'
      && typeof part.raw_text === 'string'
      && part.raw_text
      && part.resolution
      && ['prompt', 'system'].includes(part.resolution.kind)) {
      const resolution = part.resolution.kind === 'prompt'
        && typeof part.resolution.agent_text === 'string'
        && part.resolution.agent_text
        && typeof part.resolution.snapshot_id === 'string'
        && part.resolution.snapshot_id
        ? {
            kind: 'prompt',
            agent_text: part.resolution.agent_text,
            snapshot_id: part.resolution.snapshot_id,
          }
        : part.resolution.kind === 'system' ? { kind: 'system' } : null;
      return resolution ? [{
        type: 'command_ref',
        invocation_id: part.invocation_id,
        name: part.name,
        args: part.args,
        raw_text: part.raw_text,
        resolution,
      }] : [];
    }
    if (part?.type === 'command_result'
      && typeof part.invocation_id === 'string'
      && part.invocation_id
      && typeof part.name === 'string'
      && part.name
      && typeof part.success === 'boolean'
      && typeof part.text === 'string') {
      return [{
        type: 'command_result',
        invocation_id: part.invocation_id,
        name: part.name,
        success: part.success,
        text: part.text,
        ...(typeof part.error === 'string' && part.error ? { error: part.error } : {}),
      }];
    }
    return [];
  });
}

/** 图片理解插件生成的描述 part 类型（结构化，紧跟 image attachment_ref 之后）。 */
const IMAGE_DESCRIPTION_TYPE = 'image_description';

function isImageDescriptionPart(part) {
  return part?.type === IMAGE_DESCRIPTION_TYPE;
}

/**
 * 用户消息在对话列表中的展示文本：排除图片描述 part（描述以附件角标收纳，不进入正文）。
 * content_parts 不可用时回退为聚合 content（结构化描述不写入聚合列，无需剥离）。
 */
export function getUserDisplayText(message) {
  const parts = normalizeMessageContentParts(message?.content_parts);
  const textParts = parts.filter((part) => part.type === 'text' && !isImageDescriptionPart(part));
  if (textParts.length > 0) {
    return textParts.map((part) => part.text).join('\n').trim();
  }
  return typeof message?.content === 'string' ? message.content.trim() : '';
}

/**
 * 解析用户消息 content_parts，把紧跟图片 attachment_ref 之后的描述 part
 * 按 file_id 收集，供附件角标展示使用。
 * @returns {Record<string, string>}
 */
export function getImageDescriptionMap(message) {
  const parts = normalizeMessageContentParts(message?.content_parts);
  const result = {};
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part?.type !== 'attachment_ref' || part.kind !== 'image') continue;
    const next = parts[index + 1];
    if (next?.type !== IMAGE_DESCRIPTION_TYPE) continue;
    result[part.file_id] = next.text;
  }
  return result;
}

export function createUserContentParts(content, attachments) {
  const parts = content ? [{ type: 'text', text: content }] : [];
  for (const attachment of attachments || []) {
    const normalized = normalizeMessageContentParts([{
      type: 'attachment_ref',
      file_id: attachment.file_id,
      original_name: attachment.original_name || attachment.stored_name,
      stored_name: attachment.stored_name || attachment.original_name,
      mime: attachment.mime || '',
      size: Number(attachment.size || 0),
      kind: attachment.kind === 'image' ? 'image' : 'file',
      presentation: attachment.kind === 'image' ? 'inline' : 'attachment',
      ...(attachment.file_path ? { file_path: attachment.file_path } : {}),
      ...(attachment.file_path_space ? { file_path_space: attachment.file_path_space } : {}),
    }]);
    parts.push(...normalized);
  }
  return parts;
}

export function getMessageAttachments(message) {
  return normalizeMessageContentParts(message?.content_parts)
    .filter(part => part.type === 'attachment_ref')
    .map((part) => {
      const normalized = normalizeSessionAttachment(part);
      if (!normalized) return null;
      const { type: _type, presentation: _presentation, ...attachment } = normalized;
      return attachment;
    })
    .filter(Boolean);
}

export function getMessageFileRefs(message) {
  return normalizeMessageContentParts(message?.content_parts)
    .filter(part => part.type === 'file_ref');
}

export function getMessageCommandResult(message) {
  return normalizeMessageContentParts(message?.content_parts)
    .find(part => part.type === 'command_result') || null;
}

export function applyMessageContentPart(message, partIndex, part) {
  if (!message || !Number.isSafeInteger(partIndex) || partIndex < 0) return;
  const [normalized] = normalizeMessageContentParts([part]);
  if (!normalized || normalized.type === 'attachment_ref') return;
  const parts = ensureMessageContentParts(message, partIndex);
  parts[partIndex] = normalized;
}

export function applyMessageContentTextDelta(message, partIndex, delta) {
  if (!message || !Number.isSafeInteger(partIndex) || partIndex < 0 || !delta) return;
  const parts = ensureMessageContentParts(message, partIndex);
  const existing = parts[partIndex];
  if (existing?.type === 'text') existing.text += delta;
  else parts[partIndex] = { type: 'text', text: delta };
}

export function reconcileMessageContentParts(message, contentParts) {
  if (!message || !Array.isArray(contentParts)) return;
  message.content_parts = normalizeMessageContentParts(contentParts);
}

function ensureMessageContentParts(message, targetIndex) {
  if (!Array.isArray(message.content_parts)) message.content_parts = [];
  if (message.content_parts.length === 0 && targetIndex > 0 && message.content) {
    message.content_parts[0] = { type: 'text', text: message.content };
  }
  return message.content_parts;
}
