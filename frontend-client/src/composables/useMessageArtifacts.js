import { nextTick, onUnmounted, ref } from 'vue';
import { parseMessageParts } from '../utils/message-render.js';

export function useMessageArtifacts(deps) {
  const fileFocusTimer = ref(null);
  const fileFocusTarget = ref(null);

  const clearArtifactFocus = () => {
    if (fileFocusTimer.value) {
      clearTimeout(fileFocusTimer.value);
      fileFocusTimer.value = null;
    }
    fileFocusTarget.value?.classList.remove('file-inline-focus');
    fileFocusTarget.value = null;
  };

  const handleArtifactSelect = async ({ filePath } = {}) => {
    if (!filePath) return;
    await nextTick();
    const root = deps.messagesRef.value;
    const target = Array.from(root?.querySelectorAll('[data-file-path]') || [])
      .find((node) => node.getAttribute('data-file-path') === filePath);
    if (!target) return;

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    clearArtifactFocus();
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

  onUnmounted(clearArtifactFocus);

  return {
    parseMessageParts,
    handleArtifactSelect,
  };
}
