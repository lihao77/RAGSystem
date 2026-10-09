import { resolveInlineImageMime } from '@ragsystem/agent-protocol';

let localAttachmentCounter = 0;

function inferAttachmentKind(mime, filename) {
  return resolveInlineImageMime(mime, filename) ? 'image' : 'file';
}

export function normalizeSessionAttachment(file) {
  if (!file || typeof file !== 'object') return null;
  const fileId = file.file_id || file.id;
  if (!fileId) return null;
  return {
    ...file,
    source: 'session',
    file_id: fileId,
    kind: inferAttachmentKind(file.mime, file.original_name || file.stored_name),
  };
}

export function getSessionFileDownloadUrl(sessionId, fileId) {
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(fileId)}/download`;
}

export function createLocalAttachment(file) {
  if (!(file instanceof File)) return null;
  const mime = resolveInlineImageMime(file.type, file.name) || file.type || '';
  const kind = inferAttachmentKind(mime, file.name);
  return {
    source: 'local',
    local_id: `local-${Date.now()}-${localAttachmentCounter++}`,
    file,
    original_name: file.name,
    stored_name: file.name,
    mime,
    size: file.size || 0,
    kind,
    preview_url: kind === 'image' ? URL.createObjectURL(file) : '',
  };
}

export function isLocalAttachment(attachment) {
  return attachment?.source === 'local';
}

export function isSessionAttachment(attachment) {
  return attachment?.source === 'session';
}

export function getAttachmentKey(attachment) {
  if (isLocalAttachment(attachment)) return `local:${attachment.local_id}`;
  if (attachment?.file_id || attachment?.id) return `session:${attachment.file_id || attachment.id}`;
  return '';
}

export function revokeAttachmentPreviewUrl(attachment) {
  if (isLocalAttachment(attachment) && attachment?.preview_url) {
    URL.revokeObjectURL(attachment.preview_url);
  }
}

export function isImageAttachment(attachment) {
  return Boolean(resolveInlineImageMime(attachment?.mime, attachment?.original_name || attachment?.stored_name));
}

export function formatAttachmentSize(size) {
  const num = Number(size || 0);
  if (!num) return '0 B';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatAttachmentMeta(attachment) {
  const parts = [formatAttachmentSize(attachment?.size)];
  if (attachment?.mime) parts.push(attachment.mime);
  return parts.join(' · ');
}
