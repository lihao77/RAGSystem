<template>
  <div class="flex min-h-0 flex-1 flex-col gap-2">
    <div v-if="loading" class="text-sm text-muted-foreground">正在加载编辑器...</div>
    <div ref="editorHost" class="vditor-host min-h-0 flex-1 overflow-hidden rounded border"></div>
  </div>
</template>

<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useThemeStore } from '../../stores/theme.js';

const props = defineProps({ modelValue: { type: String, default: '' } });
const emit = defineEmits(['update:modelValue', 'save', 'notify']);

const loading = ref(true);
const editorHost = ref(null);
const { isDark } = storeToRefs(useThemeStore());
let vditor = null;
let disposed = false;
let applyingExternalValue = false;

const applyTheme = (dark) => {
  if (!vditor) return;
  vditor.setTheme(dark ? 'dark' : 'classic', dark ? 'dark' : 'light');
};

const handleKeydown = (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    emit('save');
  }
};

onMounted(async () => {
  try {
    const [{ default: Vditor }] = await Promise.all([
      import('vditor'),
      import('vditor/dist/index.css'),
    ]);
    if (disposed || !editorHost.value) return;

    vditor = new Vditor(editorHost.value, {
      mode: 'ir',
      value: props.modelValue,
      height: '100%',
      cache: { enable: false },
      theme: isDark.value ? 'dark' : 'classic',
      preview: { theme: { current: isDark.value ? 'dark' : 'light' } },
      input: (markdown) => {
        if (!applyingExternalValue) emit('update:modelValue', markdown);
      },
      after: () => {
        loading.value = false;
        applyTheme(isDark.value);
      },
    });
    await nextTick();
    editorHost.value.addEventListener('keydown', handleKeydown);
  } catch (error) {
    loading.value = false;
    emit('notify', { message: error.message || 'Vditor 加载失败', type: 'error' });
  }
});

watch(() => props.modelValue, (value) => {
  if (!vditor || vditor.getValue() === value) return;
  applyingExternalValue = true;
  vditor.setValue(value);
  nextTick(() => {
    applyingExternalValue = false;
  });
});

watch(isDark, applyTheme);

onBeforeUnmount(() => {
  disposed = true;
  editorHost.value?.removeEventListener('keydown', handleKeydown);
  vditor?.destroy();
  vditor = null;
});
</script>

<style scoped>
.vditor-host :deep(.vditor) {
  height: 100% !important;
  border: 0;
}
</style>
