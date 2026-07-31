import { nextTick, onUnmounted, ref } from 'vue';
import { getArtifact } from '../api/artifact.js';
import { parseMessageParts } from '../utils/message-render.js';
import { normalizeArtifactManifest } from '../utils/artifact.js';

const ARTIFACT_PLACEHOLDER_RE = /\[artifact:(art_[A-Za-z0-9_]+)\]/g;

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

    const matches = [...content.matchAll(ARTIFACT_PLACEHOLDER_RE)];
    ARTIFACT_PLACEHOLDER_RE.lastIndex = 0;
    if (!matches.length) return;

    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const artifactId = matches[i][1];
      let vizData;
      try {
        vizData = await getArtifact(artifactId);
      } catch (error) {
        console.warn('加载可视化失败:', error.message);
        continue;
      }
      try {
        const normalized = normalizeArtifactManifest(vizData);
        if (normalized.displayKind !== 'map') continue;

        const mapData = normalized.config;
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
