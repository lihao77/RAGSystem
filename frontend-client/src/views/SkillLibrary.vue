<template>
  <PageLayout
    title="Skill 库"
    subtitle="管理 Skill Draft、完整 bundle 与租户发布包"
  >
    <template #header-actions>
      <Button variant="outline" size="sm" :disabled="loadingAll" @click="handleRefresh">
        <RefreshCw data-icon="inline-start" :class="{ 'animate-spin': loadingAll }" />
        刷新
      </Button>
      <Button v-if="canEditSkillDraft" size="sm" @click="openCreateDraft">
        <Plus data-icon="inline-start" />
        新建 Draft
      </Button>
    </template>

    <div class="wb-workbench" aria-label="Skill 管理工作区">
      <SkillNavigatorPanel
        :state="state"
        :select-draft="selectDraft"
        :select-skill="selectSkill"
        :change-navigator-tab="changeNavigatorTab"
        :handle-refresh="handleRefresh"
        :set-search-query="setSearchQuery"
      />

      <Card class="wb-workbench__main">
        <main class="skill-workspace">
          <div v-if="workspaceLoading" class="adm-state">
            <Spinner />
            <span>加载工作区</span>
          </div>

          <div v-else-if="workspaceError && !activeDraft && !selectedSkill" class="adm-state adm-state--error" role="alert">
            <p class="adm-state__title">无法打开 Skill</p>
            <p class="adm-state__hint">{{ workspaceError }}</p>
          </div>

          <Empty v-else-if="!activeDraft && !selectedSkill" class="adm-state">
            <EmptyHeader>
              <EmptyTitle>选择一个 Skill</EmptyTitle>
            </EmptyHeader>
          </Empty>

          <DraftWorkspace
            v-else-if="activeKind === 'draft' && activeDraft"
            :state="state"
            :save-overview="saveOverview"
            :publish-draft="publishDraft"
            :delete-draft="deleteDraft"
            :change-workspace-tab="changeWorkspaceTab"
            :change-overview-mode="changeOverviewMode"
            :select-draft-file="selectDraftFile"
            :toggle-directory="toggleDirectory"
            :save-selected-file="saveSelectedFile"
            :delete-selected-file="deleteSelectedFile"
            :upload-selected-file="uploadSelectedFile"
            :download-selected-file="downloadSelectedFile"
            :open-create-file="openCreateFile"
            :update-draft-form="updateDraftForm"
            :set-file-text="setFileText"
          />

          <PublishedSkillPane
            v-else-if="selectedSkill"
            :state="state"
            :edit-published-skill="editPublishedSkill"
            :delete-published-skill="deletePublishedSkill"
            :change-published-tab="changePublishedTab"
            :toggle-published-directory="togglePublishedDirectory"
          />
        </main>
      </Card>
    </div>

    <FormDialog
      :open="createDraftDialog.open"
      title="新建 Skill Draft"
      description="创建基础 SKILL.md 后，可继续添加脚本和资源文件。"
      :error="createDraftDialog.error"
      :busy="creatingDraft"
      confirm-text="创建 Draft"
      :confirm-disabled="!canCreateDraft"
      content-class="max-w-[520px]"
      @update:open="(open) => { if (!open) closeCreateDraft() }"
      @submit="createDraft"
    >
      <FieldGroup>
        <Field :data-disabled="creatingDraft">
          <FieldLabel for="new-skill-name">名称</FieldLabel>
          <Input id="new-skill-name" v-model.trim="createDraftDialog.name" :disabled="creatingDraft" placeholder="example-skill" />
          <FieldDescription>使用小写字母、数字和连字符，最长 64 个字符。</FieldDescription>
        </Field>
        <Field :data-disabled="creatingDraft">
          <FieldLabel for="new-skill-description">描述</FieldLabel>
          <Input id="new-skill-description" v-model="createDraftDialog.description" :disabled="creatingDraft" />
        </Field>
      </FieldGroup>
    </FormDialog>

    <FormDialog
      :open="createFileDialog.open"
      title="新建文本文件"
      description="路径相对于 Skill bundle 根目录，例如 scripts/check.py。"
      :error="createFileDialog.error"
      :busy="fileSaving"
      confirm-text="创建文件"
      :confirm-disabled="!canCreateFile"
      content-class="max-w-[560px]"
      @update:open="(open) => { if (!open) closeCreateFile() }"
      @submit="createTextFile"
    >
      <FieldGroup>
        <Field :data-disabled="fileSaving">
          <FieldLabel for="new-file-path">文件路径</FieldLabel>
          <Input id="new-file-path" v-model.trim="createFileDialog.path" :disabled="fileSaving" placeholder="references/guide.md" />
        </Field>
        <Field :data-disabled="fileSaving">
          <FieldLabel for="new-file-content">初始内容</FieldLabel>
          <Textarea id="new-file-content" v-model="createFileDialog.content" class="new-file-textarea" :disabled="fileSaving" />
        </Field>
      </FieldGroup>
    </FormDialog>
  </PageLayout>
</template>

<script setup>
/**
 * Skill 库管理页 —— 薄组装层。
 * 状态与逻辑：composables/skill-library/（state + library + draftActions + draftFiles）
 * UI 区块：components/skill-library/（NavigatorPanel / DraftWorkspace / PublishedSkillPane / SkillFileTree）
 */
import { onMounted } from 'vue';
import { Plus, RefreshCw } from 'lucide-vue-next';

import PageLayout from '../components/PageLayout.vue';
import FormDialog from '../components/admin/FormDialog.vue';
import DraftWorkspace from '../components/skill-library/DraftWorkspace.vue';
import PublishedSkillPane from '../components/skill-library/PublishedSkillPane.vue';
import SkillNavigatorPanel from '../components/skill-library/SkillNavigatorPanel.vue';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Empty, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { Textarea } from '../components/ui/textarea';
import { createSkillLibraryState } from '../composables/skill-library/state.js';
import { useSkillDraftActions } from '../composables/skill-library/useSkillDraftActions.js';
import { useSkillDraftFiles } from '../composables/skill-library/useSkillDraftFiles.js';
import { useSkillLibrary } from '../composables/skill-library/useSkillLibrary.js';
import { useConfirm } from '../composables/useConfirm.js';
import { useToast } from '../composables/useToast.js';

const toast = useToast();
const { confirm } = useConfirm();

const state = createSkillLibraryState();
const library = useSkillLibrary(state, { toast, confirm });
const draftActions = useSkillDraftActions(state, library, { toast, confirm });
const draftFiles = useSkillDraftFiles(state, library, { toast, confirm });

// 视图模板直接使用的响应式状态（解构后仍是 ref，模板自动解包）
const {
  canEditSkillDraft, loadingAll, workspaceLoading, workspaceError, activeKind, activeDraft, selectedSkill,
  createDraftDialog, createFileDialog, creatingDraft, fileSaving, canCreateDraft, canCreateFile,
} = state;

const {
  refreshAll, handleRefresh, changeNavigatorTab, selectDraft, selectSkill,
  changeWorkspaceTab, changeOverviewMode, changePublishedTab, selectDraftFile,
  toggleDirectory, togglePublishedDirectory, setSearchQuery,
} = library;

const {
  saveOverview, publishDraft, deleteDraft, editPublishedSkill, deletePublishedSkill,
  openCreateDraft, closeCreateDraft, createDraft, updateDraftForm,
} = draftActions;

const {
  saveSelectedFile, deleteSelectedFile, uploadSelectedFile, downloadSelectedFile,
  openCreateFile, closeCreateFile, createTextFile, setFileText,
} = draftFiles;

onMounted(() => refreshAll({ selectDefault: true }));
</script>

<style scoped>
/* 页面专属样式；共享骨架见 styles/admin-workbench.css */
.skill-workspace {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 560px;
}

.new-file-textarea {
  min-height: 180px;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

@media (max-width: 1024px) {
  .skill-workspace {
    min-height: 620px;
  }

  .wb-workspace-header {
    flex-direction: column;
  }

  .wb-workspace-header__actions {
    justify-content: flex-start;
  }

  .wb-workspace-tabbar {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
