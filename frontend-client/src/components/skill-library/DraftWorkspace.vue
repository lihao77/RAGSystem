<template>
  <header class="wb-workspace-header">
    <div class="wb-workspace-header__identity">
      <div class="wb-workspace-header__title-row">
        <h2>{{ state.activeDraft.value.name }}</h2>
        <Badge :variant="draftStatusVariant(state.activeDraft.value)">{{ draftStatusLabel(state.activeDraft.value) }}</Badge>
        <Badge variant="outline">修订 {{ state.activeDraft.value.revision }}</Badge>
      </div>
      <p class="wb-workspace-header__desc">{{ state.activeDraft.value.description }}</p>
      <span class="wb-workspace-header__sub">{{ draftOrigin(state.activeDraft.value) }} · 更新于 {{ formatDraftDate(state.activeDraft.value.updated_at) }}</span>
    </div>
    <div class="wb-workspace-header__actions">
      <Button
        v-if="state.canEditSkillDraft.value && state.workspaceTab.value === 'overview'"
        variant="outline"
        size="sm"
        :disabled="state.mutationBusy.value || !state.overviewDirty.value"
        @click="saveOverview"
      >
        <Spinner v-if="state.overviewSaving.value" data-icon="inline-start" />
        <Save v-else data-icon="inline-start" />
        保存
      </Button>
      <Button
        v-if="state.canEditSkillDraft.value && (state.activeDraft.value.status !== 'published' || state.activeDraft.value.package_state === 'missing')"
        variant="success"
        size="sm"
        :disabled="state.mutationBusy.value || state.hasUnsavedChanges.value || !state.activeDraft.value.bundle_assets?.length"
        @click="publishDraft"
      >
        <Spinner v-if="state.publishing.value" data-icon="inline-start" />
        <Send v-else data-icon="inline-start" />
        {{ state.activeDraft.value.package_state === 'missing' ? '修复发布' : '发布' }}
      </Button>
      <Button
        v-if="state.canEditSkillDraft.value"
        variant="ghost"
        size="icon-sm"
        :disabled="state.mutationBusy.value"
        aria-label="删除 Draft"
        title="删除 Draft，不影响已发布 Skill"
        @click="deleteDraft"
      >
        <Trash2 data-icon="inline-start" />
      </Button>
    </div>
  </header>

  <div v-if="state.workspaceError.value" class="workspace-message" role="alert">
    <span>{{ state.workspaceError.value }}</span>
  </div>

  <div class="wb-workspace-tabbar">
    <SegmentedControl
      :model-value="state.workspaceTab.value"
      :options="workspaceTabOptions"
      aria-label="Draft 工作区"
      @update:model-value="changeWorkspaceTab"
    />
    <SegmentedControl
      v-if="state.workspaceTab.value === 'overview'"
      :model-value="state.overviewMode.value"
      :options="overviewModeOptions"
      aria-label="基本信息模式"
      @update:model-value="changeOverviewMode"
    />
  </div>

  <DraftOverviewPane v-if="state.workspaceTab.value === 'overview'" :state="state" :update-draft-form="updateDraftForm" />
  <BundleFilesPane
    v-else
    :state="state"
    :select-draft-file="selectDraftFile"
    :toggle-directory="toggleDirectory"
    :save-selected-file="saveSelectedFile"
    :delete-selected-file="deleteSelectedFile"
    :upload-selected-file="uploadSelectedFile"
    :download-selected-file="downloadSelectedFile"
    :open-create-file="openCreateFile"
    :set-file-text="setFileText"
  />
</template>

<script setup>
// Draft 工作区：头部（标题/动作）+ 分段 tabbar + overview/bundle 两个 pane。
import { Save, Send, Trash2 } from 'lucide-vue-next';

import SegmentedControl from '../SegmentedControl.vue';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import BundleFilesPane from './BundleFilesPane.vue';
import DraftOverviewPane from './DraftOverviewPane.vue';
import { draftStatusLabel, draftStatusVariant, draftOrigin, formatDraftDate } from '../../utils/skillPresentation.js';

const workspaceTabOptions = [
  { value: 'overview', label: '基本信息' },
  { value: 'files', label: 'Bundle 文件' },
];
const overviewModeOptions = [
  { value: 'edit', label: '编辑' },
  { value: 'preview', label: '预览' },
];

defineProps({
  state: { type: Object, required: true },
  saveOverview: { type: Function, required: true },
  publishDraft: { type: Function, required: true },
  deleteDraft: { type: Function, required: true },
  changeWorkspaceTab: { type: Function, required: true },
  changeOverviewMode: { type: Function, required: true },
  selectDraftFile: { type: Function, required: true },
  toggleDirectory: { type: Function, required: true },
  saveSelectedFile: { type: Function, required: true },
  deleteSelectedFile: { type: Function, required: true },
  uploadSelectedFile: { type: Function, required: true },
  downloadSelectedFile: { type: Function, required: true },
  openCreateFile: { type: Function, required: true },
  updateDraftForm: { type: Function, required: true },
  setFileText: { type: Function, required: true },
});
</script>

<style scoped>
.workspace-message {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 9px var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-error);
  font-size: var(--font-size-xs);
}
</style>
