let localAttachmentCounter = 0;

function inferAttachmentKind(mime) {
  return String(mime || '').startsWith('image/') ? 'image' : 'file';
}

export function normalizeSessionAttachment(file) {
  if (!file || typeof file !== 'object') return null;
  const fileId = file.file_id || file.id;
  if (!fileId) return null;
  return {
    ...file,
    source: 'session',
    file_id: fileId,
    kind: file.kind || inferAttachmentKind(file?.mime),
  };
}

export function createLocalAttachment(file) {
  if (!(file instanceof File)) return null;
  return {
    source: 'local',
    local_id: `local-${Date.now()}-${localAttachmentCounter++}`,
    file,
    original_name: file.name,
    stored_name: file.name,
    mime: file.type || '',
    size: file.size || 0,
    kind: inferAttachmentKind(file.type),
    preview_url: String(file.type || '').startsWith('image/') ? URL.createObjectURL(file) : '',
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
  return String(attachment?.mime || '').startsWith('image/');
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
