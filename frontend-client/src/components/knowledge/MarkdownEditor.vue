<template>
  <textarea
    ref="editor"
    class="markdown-editor min-h-0 flex-1 resize-none rounded-md border border-input bg-background p-4 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
    :value="modelValue"
    aria-label="Markdown 编辑器"
    spellcheck="false"
    @input="handleInput"
    @keydown="handleKeydown"
  ></textarea>
</template>

<script setup>
import { nextTick, ref } from 'vue';

const props = defineProps({ modelValue: { type: String, default: '' } });
const emit = defineEmits(['update:modelValue', 'save']);

const editor = ref(null);

const handleInput = (event) => {
  emit('update:modelValue', event.target.value);
};

const handleKeydown = (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    emit('save');
    return;
  }

  if (event.key !== 'Tab') return;
  event.preventDefault();
  const target = event.target;
  const start = target.selectionStart;
  const end = target.selectionEnd;
  const value = `${props.modelValue.slice(0, start)}  ${props.modelValue.slice(end)}`;
  emit('update:modelValue', value);
  nextTick(() => {
    editor.value?.setSelectionRange(start + 2, start + 2);
  });
};
</script>

<style scoped>
.markdown-editor {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 14px;
  line-height: 1.65;
  tab-size: 2;
}
</style>
