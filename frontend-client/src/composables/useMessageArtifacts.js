import { nextTick, onUnmounted, ref } from 'vue';
import { parseMessageParts } from '../utils/message-render.js';

export function useMessageArtifacts(deps) {
  const artifactFocusTimer = ref(null);
  const artifactFocusTarget = ref(null);

  const clearArtifactFocus = () => {
    if (artifactFocusTimer.value) {
      clearTimeout(artifactFocusTimer.value);
      artifactFocusTimer.value = null;
    }
    artifactFocusTarget.value?.classList.remove('artifact-inline-focus');
    artifactFocusTarget.value = null;
  };

  const handleArtifactSelect = async ({ artifactId } = {}) => {
    if (!artifactId) return;
    await nextTick();
    const root = deps.messagesRef.value;
    const target = Array.from(root?.querySelectorAll('[data-artifact-id]') || [])
      .find((node) => node.getAttribute('data-artifact-id') === artifactId);
    if (!target) return;

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    clearArtifactFocus();
    artifactFocusTarget.value = target;
    target.classList.add('artifact-inline-focus');
    artifactFocusTimer.value = setTimeout(() => {
      target.classList.remove('artifact-inline-focus');
      if (artifactFocusTarget.value === target) {
        artifactFocusTarget.value = null;
      }
      artifactFocusTimer.value = null;
    }, 1600);
  };

  onUnmounted(clearArtifactFocus);

  return {
    parseMessageParts,
    handleArtifactSelect,
  };
}
