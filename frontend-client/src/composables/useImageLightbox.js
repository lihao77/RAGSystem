import { computed, ref } from 'vue';
export function useImageLightbox() {
  const images = ref([]); const index = ref(0); const open = ref(false);
  const current = computed(() => images.value[index.value] || null);
  function show(items, selected = 0) { images.value = items.filter(item => item?.src); index.value = Math.max(0, Math.min(selected, images.value.length - 1)); open.value = images.value.length > 0; }
  function close() { open.value = false; }
  function previous() { if (images.value.length) index.value = (index.value - 1 + images.value.length) % images.value.length; }
  function next() { if (images.value.length) index.value = (index.value + 1) % images.value.length; }
  return { images, index, current, open, show, close, previous, next };
}
