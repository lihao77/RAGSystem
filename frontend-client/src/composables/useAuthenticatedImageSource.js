import { onScopeDispose, ref, toValue, watch, nextTick } from 'vue';
import { isAuthenticatedApiUrl, resolveAuthenticatedMediaUrl } from '../utils/authenticatedMedia.js';

async function decodeImage(src) {
  const image = new Image();
  image.src = src;
  await image.decode();
}

export function useAuthenticatedImageSource(source, {
  retainWhileLoading = false,
  fetchAsset,
  resolveMedia = resolveAuthenticatedMediaUrl,
  decode = decodeImage,
  onReady = () => {},
  onError = () => {},
} = {}) {
  const resolvedSrc = ref('');
  const loading = ref(false);
  let requestVersion = 0;
  let controller = null;
  let releaseCurrent = () => {};

  function clearCurrent() {
    releaseCurrent();
    releaseCurrent = () => {};
    resolvedSrc.value = '';
  }

  async function updateSource(value) {
    const version = ++requestVersion;
    controller?.abort();
    controller = null;
    const retain = toValue(retainWhileLoading);
    if (!retain || !value) clearCurrent();
    if (!value) {
      loading.value = false;
      return;
    }
    if (!retain && !isAuthenticatedApiUrl(value)) {
      onReady();
      resolvedSrc.value = value;
      loading.value = false;
      return;
    }

    controller = new AbortController();
    loading.value = true;
    let pending = null;
    try {
      pending = await resolveMedia(value, { signal: controller.signal, fetchAsset });
      if (version !== requestVersion) return;
      if (retain) await decode(pending.src);
      if (version !== requestVersion) return;

      const releasePrevious = releaseCurrent;
      onReady();
      resolvedSrc.value = pending.src;
      releaseCurrent = pending.release;
      pending = null;
      // 等 DOM 已切到新图再回收旧图，加载期间始终保留可显示的资源。
      await nextTick();
      releasePrevious();
    } catch (error) {
      if (version === requestVersion && error?.code !== 'ERR_CANCELED' && error?.name !== 'CanceledError' && error?.name !== 'AbortError') {
        onError(error);
      }
    } finally {
      pending?.release();
      if (version === requestVersion) loading.value = false;
    }
  }

  watch(() => toValue(source), updateSource, { immediate: true });
  onScopeDispose(() => {
    requestVersion += 1;
    controller?.abort();
    clearCurrent();
  });
  return { resolvedSrc, loading };
}
