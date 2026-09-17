<template>
  <div :class="cn('bundle-pane', !state.fileTreeOpen.value && 'bundle-pane--collapsed')">
    <header class="bundle-toolbar">
      <div class="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="icon-sm" class="shrink-0" :aria-expanded="state.fileTreeOpen.value" :aria-controls="treeId"
          :aria-label="state.fileTreeOpen.value ? '收起文件树' : '展开文件树'" :title="state.fileTreeOpen.value ? '收起文件树' : '展开文件树'"
          @click="emit('update:fileTreeOpen', !state.fileTreeOpen.value)">
          <component :is="state.fileTreeOpen.value ? PanelLeftClose : PanelLeftOpen" data-icon="inline-start" />
        </Button>
        <span class="bundle-toolbar__path" :title="state.selectedFile.value?.relative_path">{{ state.selectedFile.value?.relative_path || '选择文件' }}</span>
        <SkillFileChangeMarker :change="state.fileChanges.value.get(state.selectedFilePath.value)" />
      </div>
    </header>
    <div class="bundle-body">
      <aside :id="treeId" :inert="!state.fileTreeOpen.value" :aria-hidden="!state.fileTreeOpen.value" class="bundle-tree">
        <SkillFileTree class="bundle-tree__files" :nodes="state.fileTree.value" :selected-path="state.selectedFilePath.value"
          @select="handleSelectFile" @toggle="toggleDirectory" />
      </aside>
      <section class="file-editor" :aria-busy="state.loading.value">
        <Empty v-if="!state.selectedFile.value" class="adm-state"><EmptyHeader><EmptyTitle>选择一个文件</EmptyTitle></EmptyHeader></Empty>
        <SkillFilePreview v-else-if="state.editorMode.value === 'preview'" :file="state.selectedFile.value" />
        <Textarea v-else-if="state.editableSelectedFile.value" :model-value="state.fileText.value" class="file-source-editor"
          :disabled="!state.canEdit.value || state.busy.value" :readonly="state.loading.value" spellcheck="false" @update:model-value="setFileText" />
        <div v-else class="adm-state binary-file-state">
          <FileText />
          <p class="adm-state__title">此文件不在网页中直接编辑</p>
          <p class="adm-state__hint">可从右上角菜单下载检查，或上传同名文件替换。</p>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
// Skill 文件编辑缓冲：全部文件一起保存。
import { FileText, PanelLeftClose, PanelLeftOpen } from 'lucide-vue-next';
import { useId } from 'vue';
import { cn } from '../../lib/utils';

import { Button } from '../ui/button';
import { Empty, EmptyHeader, EmptyTitle } from '../ui/empty';
import { Textarea } from '../ui/textarea';
import SkillFileTree from './SkillFileTree.vue';
import SkillFilePreview from './SkillFilePreview.vue';
import SkillFileChangeMarker from './SkillFileChangeMarker.vue';

const props = defineProps({
  state: { type: Object, required: true },
  compact: { type: Boolean, default: false },
  selectFile: { type: Function, required: true },
  toggleDirectory: { type: Function, required: true },
  setFileText: { type: Function, required: true },
});

const emit = defineEmits(['update:fileTreeOpen']);
const treeId = useId();

function handleSelectFile(path) {
  props.selectFile(path);
  if (props.compact && !props.state.busy.value && !props.state.loading.value) emit('update:fileTreeOpen', false);
}

</script>

<style scoped>
.bundle-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--color-border);
}

.bundle-toolbar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  min-height: 42px;
  padding: 4px var(--spacing-sm);
  border-bottom: 1px solid var(--color-border);
}

.bundle-toolbar__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.bundle-body {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  flex: 1;
  min-height: 0;
  overflow: hidden;
  transition: grid-template-columns var(--transition-normal), grid-template-rows var(--transition-normal);
}

.bundle-tree {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--color-border);
  transition: opacity var(--transition-normal);
}

.bundle-tree__files {
  width: 200px;
}

.bundle-pane--collapsed .bundle-body {
  grid-template-columns: 0px minmax(0, 1fr);
}

.bundle-pane--collapsed .bundle-tree {
  opacity: 0;
}

.file-editor {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.file-source-editor {
  flex: 1;
  min-height: 0;
  border: none;
  border-radius: 0;
  padding: var(--spacing-lg);
  resize: none;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.65;
}

.file-source-editor:focus {
  box-shadow: none;
}

.binary-file-state {
  flex: 1;
}

.binary-file-state svg {
  width: 34px;
}

@media (max-width: 1024px) {
  .bundle-body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 0.3fr) minmax(0, 0.7fr);
  }

  .bundle-tree {
    border-right: none;
    border-bottom: 1px solid var(--color-border);
  }

  .bundle-tree__files {
    width: 100%;
  }

  .bundle-pane--collapsed .bundle-body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 0fr) minmax(0, 1fr);
  }
}
</style>
