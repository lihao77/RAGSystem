<template>
  <div class="overview-pane">
    <div v-if="state.overviewMode.value === 'edit'" class="overview-editor">
      <FieldGroup>
        <Field :data-disabled="!state.canEditSkillDraft.value || state.draftNameLocked.value || state.mutationBusy.value">
          <FieldLabel for="draft-name">名称</FieldLabel>
          <Input
            id="draft-name"
            :model-value="state.draftForm.value.name"
            :disabled="!state.canEditSkillDraft.value || state.draftNameLocked.value || state.mutationBusy.value"
            @update:model-value="(v) => updateDraftForm('name', v.trim())"
          />
          <FieldDescription v-if="state.draftNameLocked.value">已发布 Skill 的名称保持不变。</FieldDescription>
        </Field>
        <Field :data-disabled="!state.canEditSkillDraft.value || state.mutationBusy.value">
          <FieldLabel for="draft-description">描述</FieldLabel>
          <Input
            id="draft-description"
            :model-value="state.draftForm.value.description"
            :disabled="!state.canEditSkillDraft.value || state.mutationBusy.value"
            @update:model-value="(v) => updateDraftForm('description', v)"
          />
        </Field>
        <Field :data-disabled="!state.canEditSkillDraft.value || state.mutationBusy.value">
          <div class="field-heading">
            <FieldLabel for="draft-content">SKILL.md 正文</FieldLabel>
            <span>{{ state.draftForm.value.content.length.toLocaleString() }} / 30,000</span>
          </div>
          <Textarea
            id="draft-content"
            :model-value="state.draftForm.value.content"
            class="overview-textarea"
            :disabled="!state.canEditSkillDraft.value || state.mutationBusy.value"
            @update:model-value="(v) => updateDraftForm('content', v)"
          />
          <FieldDescription>结构化编辑会保留 SKILL.md 中的其他 frontmatter；源文件可在 Bundle 文件中直接修改。</FieldDescription>
        </Field>
      </FieldGroup>
    </div>
    <section v-else class="overview-preview" aria-label="Markdown 预览">
      <PaneHeading class="wb-pane-heading--bar" title="SKILL.md" subtitle="正文渲染结果">
        <template #actions>
          <Eye />
        </template>
      </PaneHeading>
      <div class="overview-preview__body">
        <MarkdownContent :content="state.draftForm.value.content" :render-markdown="renderMarkdown" @notify="onMdNotify" />
      </div>
    </section>
  </div>
</template>

<script setup>
// Draft 基本信息 pane：编辑表单 / Markdown 预览。
import { Eye } from 'lucide-vue-next';

import PaneHeading from '../admin/PaneHeading.vue';
import MarkdownContent from '../chat/MarkdownContent.vue';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { useToast } from '../../composables/useToast.js';
import { renderMarkdown } from '../../utils/markdown';

defineProps({
  state: { type: Object, required: true },
  updateDraftForm: { type: Function, required: true },
});

const toast = useToast();
function onMdNotify({ message, type }) {
  if (type === 'success') toast.success(message);
  else toast.error(message);
}
</script>

<style scoped>
.overview-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.overview-editor,
.overview-preview {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}

.overview-editor {
  width: min(100%, 980px);
  margin: 0 auto;
  padding: var(--spacing-xl) var(--spacing-lg);
}

.overview-preview {
  display: flex;
  flex: 1;
  flex-direction: column;
  margin: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: transparent;
  overflow: hidden;
}

.overview-textarea {
  min-height: 310px;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  line-height: 1.65;
}

.field-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-xs);
}

.field-heading > span {
  color: var(--color-text-muted);
  font-size: 11px;
}

.overview-preview__body {
  flex: 1;
  min-height: 0;
  padding: var(--spacing-md);
  overflow-y: auto;
}
</style>
