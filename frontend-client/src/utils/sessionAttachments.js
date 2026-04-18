export function normalizeAttachment(file) {
  if (!file || typeof file !== 'object') return null;
  return {
    ...file,
    file_id: file.file_id || file.id,
    kind: String(file?.mime || '').startsWith('image/') ? 'image' : 'file',
  };
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
