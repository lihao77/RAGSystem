<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <div class="flex gap-2">
      <button v-for="item in modes" :key="item.value" class="rounded border px-3 py-1 text-sm" :class="mode === item.value ? 'bg-primary text-primary-foreground' : ''" @click="mode = item.value">{{ item.label }}</button>
    </div>
    <div class="grid min-h-0 flex-1 gap-3" :class="mode === 'split' ? 'grid-cols-2' : 'grid-cols-1'">
      <div v-show="mode !== 'preview'" ref="editorHost" class="min-h-[55vh] overflow-hidden rounded border"></div>
      <div v-if="mode !== 'edit'" class="min-h-[55vh] overflow-auto rounded border p-4"><MarkdownContent :content="modelValue" @notify="emit('notify', $event)" /></div>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import MarkdownContent from '../chat/MarkdownContent.vue';

const props = defineProps({ modelValue: { type: String, default: '' } });
const emit = defineEmits(['update:modelValue', 'save', 'notify']);
const modes = [{ value: 'edit', label: '编辑' }, { value: 'split', label: '分屏' }, { value: 'preview', label: '预览' }];
const mode = ref('split');
const editorHost = ref(null);
let view;

const mountEditor = async () => {
  if (view || !editorHost.value) return;
  const [{ EditorState }, { EditorView, keymap }, { defaultKeymap, history, historyKeymap }, { searchKeymap }, { markdown }] = await Promise.all([
    import('@codemirror/state'), import('@codemirror/view'), import('@codemirror/commands'), import('@codemirror/search'), import('@codemirror/lang-markdown'),
  ]);
  view = new EditorView({
    parent: editorHost.value,
    state: EditorState.create({ doc: props.modelValue, extensions: [history(), markdown(), keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, { key: 'Mod-s', preventDefault: true, run: () => { emit('save'); return true; } }]), EditorView.lineWrapping, EditorView.updateListener.of((update) => { if (update.docChanged) emit('update:modelValue', update.state.doc.toString()); })] }),
  });
};

watch(editorHost, () => nextTick(mountEditor), { immediate: true });
watch(() => props.modelValue, (value) => { if (view && value !== view.state.doc.toString()) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); });
onBeforeUnmount(() => view?.destroy());
</script>
