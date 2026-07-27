<template>
  <img
    v-bind="$attrs"
    :src="resolvedSrc || TRANSPARENT_PIXEL"
    :aria-busy="loading || undefined"
    @load="onLoad"
    @error="onError"
  />
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue';
import { isAuthenticatedApiUrl, resolveAuthenticatedMediaUrl } from '../../utils/authenticatedMedia.js';

defineOptions({ inheritAttrs: false });

const props = defineProps({
  src: { type: String, default: '' },
});
const emit = defineEmits(['load', 'error']);

const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
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

async function updateSource(source) {
  const version = ++requestVersion;
  controller?.abort();
  controller = null;
  clearCurrent();

  if (!source) {
    loading.value = false;
    return;
  }
  if (!isAuthenticatedApiUrl(source)) {
    resolvedSrc.value = source;
    loading.value = false;
    return;
  }

  controller = new AbortController();
  loading.value = true;
  try {
    const result = await resolveAuthenticatedMediaUrl(source, { signal: controller.signal });
    if (version !== requestVersion) {
      result.release();
      return;
    }
    resolvedSrc.value = result.src;
    releaseCurrent = result.release;
  } catch (error) {
    if (version === requestVersion && error?.code !== 'ERR_CANCELED' && error?.name !== 'CanceledError') {
      emit('error', error);
    }
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}

function onLoad(event) {
  if (resolvedSrc.value) emit('load', event);
}

function onError(event) {
  if (resolvedSrc.value) emit('error', event);
}

watch(() => props.src, updateSource, { immediate: true });

onBeforeUnmount(() => {
  requestVersion += 1;
  controller?.abort();
  clearCurrent();
});
</script>
