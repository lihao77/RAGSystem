<template>
  <header class="wb-workspace-header">
    <div class="wb-workspace-header__identity">
      <div class="wb-workspace-header__title-row">
        <h2>{{ state.selectedSkill.value.display_name || state.selectedSkill.value.name }}</h2>
        <Badge variant="outline">{{ sourceLabel(state.selectedSkill.value.source_type) }}</Badge>
      </div>
      <p class="wb-workspace-header__desc">{{ state.selectedSkill.value.description }}</p>
      <span class="wb-workspace-header__sub">{{ state.selectedSkill.value.name }} · {{ state.publishedFileCount.value }} 个文件</span>
    </div>
    <div v-if="state.selectedSkill.value.source_type === 'user_global' && state.canEditSkillDraft.value" class="wb-workspace-header__actions">
      <Button variant="outline" size="sm" :disabled="state.mutationBusy.value" @click="editPublishedSkill">
        <Spinner v-if="state.restoringDraft.value" data-icon="inline-start" />
        <FilePenLine v-else data-icon="inline-start" />
        编辑 Draft
      </Button>
      <Button variant="destructive" size="sm" :disabled="state.mutationBusy.value" @click="deletePublishedSkill">
        <Trash2 data-icon="inline-start" />
        删除 Skill
      </Button>
    </div>
  </header>

  <div v-if="state.workspaceError.value" class="workspace-message" role="alert">
    <span>{{ state.workspaceError.value }}</span>
  </div>

  <div class="published-pane">
    <div class="published-tabbar">
      <ToggleGroup
        type="single"
        variant="segment"
        size="segment"
        :model-value="state.publishedTab.value"
        class="segmented-track"
        aria-label="已发布 Skill 视图"
        @update:model-value="changePublishedTab"
      >
        <ToggleGroupItem value="overview">说明</ToggleGroupItem>
        <ToggleGroupItem value="files">文件 <span class="published-tabs__count">{{ state.publishedFileCount.value }}</span></ToggleGroupItem>
      </ToggleGroup>
    </div>
    <section v-if="state.publishedTab.value === 'overview'" class="published-content">
      <PaneHeading class="wb-pane-heading--bar" title="SKILL.md" subtitle="已发布正文" />
      <div class="published-content__body">
        <MarkdownContent :content="state.selectedSkill.value.content" :render-markdown="renderMarkdown" @notify="onMdNotify" />
      </div>
    </section>
    <section v-else class="published-files">
      <PaneHeading class="wb-pane-heading--bar" title="已发布文件" subtitle="只读 bundle" />
      <SkillFileTree
        :nodes="state.publishedFileTree.value"
        :href-for="(path) => getSkillFileUrl(state.selectedSkill.value.name, path)"
        @toggle="togglePublishedDirectory"
      />
    </section>
  </div>
</template>

<script setup>
// 已发布 Skill 只读视图：头部动作（编辑 Draft/删除）+ 说明/文件两个 pane。
import { FilePenLine, Trash2 } from 'lucide-vue-next';

import PaneHeading from '../admin/PaneHeading.vue';
import MarkdownContent from '../chat/MarkdownContent.vue';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import SkillFileTree from './SkillFileTree.vue';
import { getSkillFileUrl } from '../../api/skillLibrary.js';
import { useToast } from '../../composables/useToast.js';
import { renderMarkdown } from '../../utils/markdown';
import { sourceLabel } from '../../utils/skillPresentation.js';

defineProps({
  state: { type: Object, required: true },
  editPublishedSkill: { type: Function, required: true },
  deletePublishedSkill: { type: Function, required: true },
  changePublishedTab: { type: Function, required: true },
  togglePublishedDirectory: { type: Function, required: true },
});

const toast = useToast();
function onMdNotify({ message, type }) {
  if (type === 'success') toast.success(message);
  else toast.error(message);
}
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

.published-pane {
  display: flex;
  min-height: 520px;
  flex: none;
  flex-direction: column;
  gap: var(--spacing-sm);
  overflow: hidden;
  margin-top: var(--spacing-sm);
  border-top: 1px solid var(--color-border);
}

.published-tabbar {
  padding: var(--spacing-md) var(--spacing-lg) 0;
}

.published-tabs__count {
  color: var(--color-text-muted);
  font-size: 11px;
}

.published-content {
  display: flex;
  min-height: 520px;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
}

.published-content__body {
  flex: 1;
  min-height: 0;
  padding: var(--spacing-md);
  overflow-y: auto;
}

.published-files {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  margin: 0 var(--spacing-lg) var(--spacing-lg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}

@media (max-width: 1024px) {
  .published-content,
  .published-files {
    min-height: 420px;
  }
}
</style>
