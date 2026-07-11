import { nextTick, onUnmounted, ref } from 'vue';
import { getVisualization } from '../api/artifact.js';
import { parseMessageParts } from '../utils/message-render.js';

const VIZ_PLACEHOLDER_RE = /\[viz:(viz_\w+)\]/g;

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

  const checkSituationScreenTrigger = async (content) => {
    if (!content || deps.situationScreenActive.value) return;

    const matches = [...content.matchAll(VIZ_PLACEHOLDER_RE)];
    VIZ_PLACEHOLDER_RE.lastIndex = 0;
    if (!matches.length) return;

    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const artifactId = matches[i][1];
      let vizData;
      try {
        vizData = await getVisualization(artifactId);
      } catch (error) {
        console.warn('加载可视化失败:', error.message);
        continue;
      }
      try {
        if (vizData.viz_type !== 'map') continue;

        const mapData = vizData.config;
        const mapType = mapData?.map_type;
        if (mapType === 'risk' || mapType === 'bindmap') {
          deps.situationArtifactId.value = artifactId;
          deps.situationMapData.value = mapData;
          deps.situationInfo.value = mapData.assessment_summary || null;
          deps.situationScreenActive.value = true;
          return;
        }
      } catch (error) {
        console.warn('检查态势大屏触发失败:', error);
      }
    }
  };

  const handleEnterSituation = ({ artifactId, mapData } = {}) => {
    if (!mapData) return;
    deps.situationArtifactId.value = artifactId || null;
    deps.situationMapData.value = mapData;
    deps.situationInfo.value = mapData?.assessment_summary || null;
    deps.situationScreenActive.value = true;
  };

  onUnmounted(clearArtifactFocus);

  return {
    parseMessageParts,
    handleArtifactSelect,
    checkSituationScreenTrigger,
    handleEnterSituation,
  };
}
