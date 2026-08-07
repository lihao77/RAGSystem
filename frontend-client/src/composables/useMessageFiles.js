import { nextTick, onUnmounted, ref } from 'vue';

/**
 * Find a file reference in the message list. A scoped selection must never
 * fall back to the first matching path: identical paths are valid across runs.
 */
export function findMessageFileTarget(root, selection = {}) {
  const filePath = typeof selection.filePath === 'string' ? selection.filePath : '';
  if (!root || !filePath) return null;

  const scope = selection.messageKey
    ? ['data-message-key', String(selection.messageKey)]
    : selection.messageId
      ? ['data-message-id', String(selection.messageId)]
      : selection.messageSeq != null
        ? ['data-message-seq', String(selection.messageSeq)]
        : selection.runId
          ? ['data-run-id', String(selection.runId)]
          : null;

  return Array.from(root.querySelectorAll?.('[data-file-path]') || [])
    .find((node) => {
      if (node.getAttribute('data-file-path') !== filePath) return false;
      return !scope || node.getAttribute(scope[0]) === scope[1];
    }) || null;
}

export function useMessageFiles(deps) {
  const fileFocusTimer = ref(null);
  const fileFocusTarget = ref(null);

  const clearFileFocus = () => {
    if (fileFocusTimer.value) {
      clearTimeout(fileFocusTimer.value);
      fileFocusTimer.value = null;
    }
    fileFocusTarget.value?.classList.remove('file-inline-focus');
    fileFocusTarget.value = null;
  };

  const handleFileSelect = async (selection = {}) => {
    if (!selection.filePath) return;
    await nextTick();
    const root = deps.messagesRef.value;
    const target = findMessageFileTarget(root, selection);
    if (!target) return;

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    clearFileFocus();
    fileFocusTarget.value = target;
    target.classList.add('file-inline-focus');
    fileFocusTimer.value = setTimeout(() => {
      target.classList.remove('file-inline-focus');
      if (fileFocusTarget.value === target) {
        fileFocusTarget.value = null;
      }
      fileFocusTimer.value = null;
    }, 1600);
  };

  onUnmounted(clearFileFocus);

  return {
    handleFileSelect,
  };
}
