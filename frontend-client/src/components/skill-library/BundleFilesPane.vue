<template>
  <div class="bundle-pane">
    <aside class="bundle-tree">
      <PaneHeading
        class="wb-pane-heading--bar"
        title="文件"
        :subtitle="`${state.activeDraft.value.bundle_assets.length} 个文件 · ${formatSize(state.bundleSize.value)}`"
      >
        <template v-if="state.canEditSkillDraft.value" #actions>
          <Button
            variant="ghost"
            size="icon-xs"
            :disabled="state.mutationBusy.value"
            aria-label="新建文本文件"
            title="新建文本文件"
            @click="openCreateFile"
          >
            <FilePlus2 data-icon="inline-start" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            :disabled="state.mutationBusy.value"
            aria-label="上传文件"
            title="上传或替换文件"
            @click="openFilePicker"
          >
            <Upload data-icon="inline-start" />
          </Button>
          <input ref="fileInput" class="sr-only" type="file" @change="uploadSelectedFile" />
        </template>
      </PaneHeading>
      <SkillFileTree
        :nodes="state.draftFileTree.value"
        :selected-path="state.selectedFilePath.value"
        @select="(path) => selectDraftFile(path)"
        @toggle="toggleDirectory"
      />
    </aside>

    <section class="file-editor">
      <div v-if="state.fileLoading.value" class="adm-state">
        <Spinner />
        <span>读取文件</span>
      </div>
      <Empty v-else-if="!state.selectedFile.value" class="adm-state">
        <EmptyHeader>
          <EmptyTitle>选择一个文件</EmptyTitle>
        </EmptyHeader>
      </Empty>
      <template v-else>
        <div class="file-editor__toolbar">
          <div class="file-editor__identity">
            <strong>{{ state.selectedFile.value.relative_path }}</strong>
            <span>{{ state.selectedFile.value.media_type }} · {{ formatSize(state.selectedFile.value.size) }}</span>
          </div>
          <div class="file-editor__actions">
            <Button variant="outline" size="sm" @click="downloadSelectedFile">
              <Download data-icon="inline-start" />
              下载
            </Button>
            <Button
              v-if="state.canEditSkillDraft.value && state.editableSelectedFile.value"
              size="sm"
              :disabled="state.mutationBusy.value || !state.fileDirty.value"
              @click="saveSelectedFile"
            >
              <Spinner v-if="state.fileSaving.value" data-icon="inline-start" />
              <Save v-else data-icon="inline-start" />
              保存文件
            </Button>
            <Button
              v-if="state.canEditSkillDraft.value && state.selectedFile.value.relative_path !== 'SKILL.md'"
              variant="ghost"
              size="icon-sm"
              :disabled="state.mutationBusy.value"
              aria-label="删除文件"
              title="从 Draft bundle 删除"
              @click="deleteSelectedFile"
            >
              <Trash2 data-icon="inline-start" />
            </Button>
          </div>
        </div>
        <Textarea
          v-if="state.editableSelectedFile.value"
          :model-value="state.fileText.value"
          class="file-source-editor"
          :disabled="!state.canEditSkillDraft.value || state.mutationBusy.value"
          spellcheck="false"
          @update:model-value="setFileText"
        />
        <div v-else class="adm-state binary-file-state">
          <FileText />
          <p class="adm-state__title">此文件不在网页中直接编辑</p>
          <p class="adm-state__hint">可下载检查，或使用“上传文件”选择同名文件替换。</p>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup>
// Draft bundle 文件 pane：左文件树 + 右源码编辑器。
import { Download, FilePlus2, FileText, Save, Trash2, Upload } from 'lucide-vue-next';
import { ref } from 'vue';

import PaneHeading from '../admin/PaneHeading.vue';
import { Button } from '../ui/button';
import { Empty, EmptyHeader, EmptyTitle } from '../ui/empty';
import { Spinner } from '../ui/spinner';
import { Textarea } from '../ui/textarea';
import SkillFileTree from './SkillFileTree.vue';
import { formatSize } from '../../utils/skillFiles.js';

const props = defineProps({
  state: { type: Object, required: true },
  selectDraftFile: { type: Function, required: true },
  toggleDirectory: { type: Function, required: true },
  saveSelectedFile: { type: Function, required: true },
  deleteSelectedFile: { type: Function, required: true },
  uploadSelectedFile: { type: Function, required: true },
  downloadSelectedFile: { type: Function, required: true },
  openCreateFile: { type: Function, required: true },
  setFileText: { type: Function, required: true },
});

const fileInput = ref(null);

function openFilePicker() {
  if (!props.state.activeDraft.value || props.state.mutationBusy.value) return;
  fileInput.value?.click();
}
</script>

<style scoped>
.bundle-pane {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  height: 620px;
  flex: none;
  min-height: 480px;
  overflow: hidden;
  margin-top: var(--spacing-sm);
  border-top: 1px solid var(--color-border);
}

.bundle-tree {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--color-border);
  background: transparent;
}

.file-editor {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.file-editor__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-xs);
  min-height: 58px;
  padding: var(--spacing-sm) var(--spacing-md);
  border-bottom: 1px solid var(--color-border);
}

.file-editor__identity {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.file-editor__identity strong {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
}

.file-editor__identity span {
  color: var(--color-text-muted);
  font-size: 11px;
}

.file-editor__identity strong,
.file-editor__identity span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-editor__actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  flex-shrink: 0;
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
  .bundle-pane {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }

  .bundle-tree {
    max-height: 280px;
    border-right: none;
    border-bottom: 1px solid var(--color-border);
  }

  .file-editor {
    min-height: 420px;
  }
}
</style>
