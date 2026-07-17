export function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : '—';
}
