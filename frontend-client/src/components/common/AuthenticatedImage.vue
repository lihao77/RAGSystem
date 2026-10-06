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
import { inject, toRef } from 'vue';
import { useAuthenticatedImageSource } from '../../composables/useAuthenticatedImageSource.js';

defineOptions({ inheritAttrs: false });

const props = defineProps({
  src: { type: String, default: '' },
  retainWhileLoading: Boolean,
});
const emit = defineEmits(['load', 'error', 'source-ready']);
const chatSdkClient = inject('chatSdkClient', null);

const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
const { resolvedSrc, loading } = useAuthenticatedImageSource(toRef(props, 'src'), {
  retainWhileLoading: toRef(props, 'retainWhileLoading'),
  fetchAsset: chatSdkClient?.fetchAsset?.bind(chatSdkClient),
  onReady: () => emit('source-ready'),
  onError: (error) => emit('error', error),
});

function onLoad(event) {
  if (resolvedSrc.value) emit('load', event);
}

function onError(event) {
  if (resolvedSrc.value) emit('error', event);
}
</script>
