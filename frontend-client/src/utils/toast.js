export function showToast(toast, message, type = 'error') {
  if (type === 'success') toast.success(message);
  else if (type === 'warning') toast.warning(message);
  else toast.error(message);
}
