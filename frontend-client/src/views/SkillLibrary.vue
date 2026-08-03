<template>
  <PageLayout
    title="Skill 库"
    subtitle="领域技能的增删改与上下传"
    mobile-content-padding="var(--spacing-sm)"
  >
    <template #header-actions>
      <Button variant="ghost" size="icon-sm" :disabled="loading || editorBusy" aria-label="新建 Skill" title="新建 Skill" @click="openCreate">
        <IconPlus :size="14" :stroke-width="2.5" />
      </Button>
    </template>

    <KpiCards :items="kpiItems" />

    <section class="skill-drafts" aria-labelledby="skill-drafts-title">
      <div class="skill-drafts__header">
        <div>
          <h2 id="skill-drafts-title" class="skill-drafts__title">Skill 草稿审核</h2>
          <p class="skill-drafts__description">Agent 通过作者工具只能提交草稿；发布后才会进入可用 Skill 清单。</p>
        </div>
        <div class="skill-drafts__actions">
          <Badge variant="secondary">{{ skillDrafts.length }}</Badge>
          <Button variant="ghost" size="icon-sm" :disabled="draftLoading" aria-label="刷新 Skill 草稿" title="刷新 Skill 草稿" @click="loadDrafts">
            <RefreshCw data-icon="inline-start" :class="{ 'animate-spin': draftLoading }" />
          </Button>
        </div>
      </div>
      <div v-if="draftLoading && !skillDrafts.length" class="skill-drafts__state">加载草稿中…</div>
      <div v-else-if="draftError" class="skill-drafts__state skill-drafts__state--error" role="alert">
        <span>{{ draftError }}</span>
        <Button variant="outline" size="sm" @click="loadDrafts">重试</Button>
      </div>
      <Empty v-else-if="!skillDrafts.length" class="skill-drafts__empty">
        <EmptyHeader>
          <EmptyTitle>暂无 Skill 草稿</EmptyTitle>
          <EmptyDescription>Agent Builder 提炼出可复用流程后，草稿会出现在这里。</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <div v-else class="skill-drafts__list">
        <div v-for="draft in skillDrafts" :key="draft.id" class="skill-draft-row">
          <div class="skill-draft-row__main">
            <div class="skill-draft-row__title">
              <span class="skill-draft-row__name">{{ draft.name }}</span>
              <Badge :variant="draftStatusVariant(draft.status)">{{ draftStatusLabel(draft.status) }}</Badge>
              <span class="skill-draft-row__revision">修订 {{ draft.revision }}</span>
            </div>
            <p class="skill-draft-row__description">{{ draft.description }}</p>
            <p class="skill-draft-row__source">
              {{ draft.source_agent_name || '人工创建' }}<span v-if="draft.source_session_id"> · 会话 {{ draft.source_session_id }}</span>
              <span> · 更新于 {{ formatDraftDate(draft.updated_at) }}</span>
            </p>
          </div>
          <Button variant="secondary" size="sm" @click="openDraftReview(draft)">
            <Eye data-icon="inline-start" />
            <span>{{ draft.status === 'published' ? '查看' : '审核' }}</span>
          </Button>
        </div>
      </div>
    </section>

    <div class="skill-lib">
      <EntityListLayout
        title="技能清单"
        description="按来源分组，点击查看详情"
        :loading="loading"
        :error="error"
        empty-title="暂无 Skill"
        empty-hint="点“新建 Skill”创建第一个"
        :empty="!loading && !error && !skills.length"
        @retry="refresh"
      >
        <div class="skill-search">
          <IconSearch class="skill-search__icon" :size="14" />
          <input v-model="searchQuery" class="skill-search__input" placeholder="搜索名称或描述…" />
          <button v-if="searchQuery" type="button" class="skill-search__clear" aria-label="清除" @click="searchQuery = ''">
            <IconClose :size="12" />
          </button>
        </div>
        <div class="adm-entity-list">
          <div v-for="group in groups" :key="group.key" class="skill-list-group">
            <div class="skill-list-group__head">
              <span>{{ group.title }}</span>
              <UiBadge size="sm">{{ group.items.length }}</UiBadge>
            </div>
            <button
              v-for="skill in group.items"
              :key="skill.name"
              type="button"
              class="adm-entity-row skill-row"
              :class="{
                'skill-row--active': selected && selected.name === skill.name,
                'skill-row--readonly': !isWritable(skill),
              }"
              @click="selectSkill(skill.name)"
            >
              <div class="skill-row__main">
                <div class="skill-row__name-row">
                  <span class="skill-row__name">{{ skill.display_name || skill.name }}</span>
                  <UiBadge size="sm" :tone="sourceMeta(skill.source_type).tone">{{ sourceMeta(skill.source_type).label }}</UiBadge>
                </div>
                <div class="skill-row__desc">{{ skill.description }}</div>
              </div>
            </button>
          </div>
          <EmptyState v-if="searchQuery && !groups.length" compact :title="`未找到匹配「${searchQuery}」的 Skill`" />
        </div>
      </EntityListLayout>

      <Card class="skill-detail-panel">
        <div v-if="detailLoading" class="adm-state">
          <div class="g-spinner" aria-hidden="true"></div>
          <p>加载详情中…</p>
        </div>
        <div v-else-if="detailError" class="adm-state adm-state--error">
          <p>{{ detailError }}</p>
        </div>
        <div v-else-if="!selected" class="adm-state">
          <p class="adm-state__title">选择一个 Skill</p>
          <p class="adm-state__hint">从左侧选择查看正文与脚本</p>
        </div>
        <template v-else>
          <CardHeader class="gap-y-4">
            <div class="space-y-1 min-w-0">
              <CardTitle>{{ selected.display_name || selected.name }}</CardTitle>
              <CardDescription>{{ selected.description }}</CardDescription>
              <div class="skill-detail__chips">
                <UiBadge size="sm">{{ selected.source_label }}</UiBadge>
                <UiBadge v-if="!selected.writable" size="sm">只读</UiBadge>
                <UiBadge v-else size="sm" tone="success">可编辑</UiBadge>
              </div>
            </div>
            <div v-if="selected.writable" class="skill-detail__actions">
              <Button variant="secondary" size="sm" @click="openEdit">
                <IconEdit :size="13" /><span>编辑正文</span>
              </Button>
              <Button variant="secondary" size="sm" @click="openUpload">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                <span>上传脚本</span>
              </Button>
              <Button variant="destructive" size="sm" :disabled="deleting" @click="confirmDelete">
                <IconTrash :size="13" /><span>{{ deleting ? '删除中…' : '删除' }}</span>
              </Button>
            </div>
          </CardHeader>
          <CardContent>

          <div v-if="selected.files && selected.files.length" class="skill-section">
            <div class="skill-section__title">文件</div>
            <ul class="skill-filetree">
              <li
                v-for="f in flatFiles"
                :key="f.path"
                :class="['skill-file', `skill-file--${f.type}`, { 'skill-file--collapsed': f.collapsed }]"
              >
                <button
                  v-if="f.type === 'directory'"
                  type="button"
                  class="skill-file__row skill-file__row--dir"
                  :style="{ paddingLeft: `${f.depth * 16 + 8}px` }"
                  @click="toggleDir(f.path)"
                >
                  <span class="skill-file__chevron" :class="{ 'is-open': !f.collapsed }"><IconChevronDown :size="12" /></span>
                  <span class="skill-file__icon" v-html="FOLDER_ICON"></span>
                  <span class="skill-file__name">{{ f.name }}</span>
                </button>
                <div
                  v-else
                  class="skill-file__row"
                  :style="{ paddingLeft: `${f.depth * 16 + 24}px` }"
                >
                  <span class="skill-file__icon" v-html="FILE_ICON"></span>
                  <a :href="fileUrl(f.path)" target="_blank" rel="noopener" class="skill-file__name">{{ f.name }}</a>
                  <span v-if="f.size != null" class="skill-file__size">{{ formatSize(f.size) }}</span>
                </div>
              </li>
            </ul>
          </div>

          <div class="skill-section">
            <div class="skill-section__title">SKILL.md 正文</div>
            <MarkdownContent :content="selected.content" :render-markdown="renderMarkdown" @notify="onMdNotify" />
          </div>
          </CardContent>
        </template>
      </Card>
    </div>

    <Dialog :open="editor.open" @update:open="(v) => { if (!v) closeEditor() }">
      <DialogContent class="max-w-[680px]">
        <DialogHeader>
          <DialogTitle>{{ editorTitle }}</DialogTitle>
        </DialogHeader>
        <div class="form-section">
        <label v-if="editor.mode === 'create'" class="form-item">
          <span class="field-label-text">名称（小写字母 / 数字 / 连字符）</span>
          <Input v-model.trim="editor.form.name" placeholder="如 my-skill" />
        </label>
        <label v-if="editor.mode === 'create'" class="form-item">
          <span class="field-label-text">描述</span>
          <Input v-model="editor.form.description" placeholder="一句话说明适用场景" />
        </label>
        <label class="form-item">
          <span class="field-label-text">正文（Markdown）</span>
          <Textarea v-model="editor.form.content" rows="14" class="form-control--textarea skill-textarea"></Textarea>
        </label>
        <p v-if="editor.error" class="form-error">{{ editor.error }}</p>
      </div>
      <DialogFooter>
        <Button variant="ghost" @click="closeEditor">取消</Button>
        <Button variant="default" :disabled="editorBusy" @click="saveEditor">
          {{ editorBusy ? '保存中…' : '保存' }}
        </Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="uploader.open" @update:open="(v) => { if (!v) closeUploader() }">
      <DialogContent class="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{{ uploadTitle }}</DialogTitle>
        </DialogHeader>
        <div class="form-section">
        <div class="form-item">
          <span class="field-label-text">目标目录</span>
          <CustomSelect v-model="uploader.dir" :options="dirOptions" />
        </div>
        <div class="form-item">
          <span class="field-label-text">文件</span>
          <div class="skill-file-picker" @click="triggerFilePick">
            <input ref="fileInputRef" type="file" multiple class="skill-file-picker__input" @change="onFileChange" />
            <template v-if="uploader.files.length">
              <IconFile :size="14" class="skill-file-picker__icon" />
              <span class="skill-file-picker__list">{{ uploader.files.map((f) => f.name).join('、') }}</span>
              <Button variant="action-danger" size="action" title="清除" @click.stop="clearFiles"><IconClose :size="12" /></Button>
            </template>
            <template v-else>
              <IconFile :size="14" class="skill-file-picker__icon" />
              <span class="skill-file-picker__hint">点击选择文件（可多选）</span>
            </template>
          </div>
        </div>
        <p v-if="uploader.error" class="form-error">{{ uploader.error }}</p>
      </div>
      <DialogFooter>
        <Button variant="ghost" @click="closeUploader">取消</Button>
        <Button variant="default" :disabled="uploaderBusy || !uploader.files.length" @click="doUpload">
          {{ uploaderBusy ? '上传中…' : '上传' }}
        </Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="draftReview.open" @update:open="(v) => { if (!v) closeDraftReview() }">
      <DialogContent class="max-w-[900px]">
        <DialogHeader>
          <DialogTitle>{{ draftReview.form.name || 'Skill 草稿审核' }}</DialogTitle>
          <DialogDescription>草稿不会自动绑定到 Agent；管理员发布后才会成为正式 Skill。</DialogDescription>
        </DialogHeader>
        <FieldGroup class="skill-draft-form">
          <Field>
            <FieldLabel for="skill-draft-name">名称</FieldLabel>
            <Input id="skill-draft-name" v-model.trim="draftReview.form.name" :disabled="draftReviewReadonly || draftReviewBusy" />
          </Field>
          <Field>
            <FieldLabel for="skill-draft-description">描述</FieldLabel>
            <Input id="skill-draft-description" v-model="draftReview.form.description" :disabled="draftReviewReadonly || draftReviewBusy" />
          </Field>
          <Field>
            <FieldLabel for="skill-draft-content">SKILL.md 正文</FieldLabel>
            <Textarea id="skill-draft-content" v-model="draftReview.form.content" rows="12" class="skill-textarea" :disabled="draftReviewReadonly || draftReviewBusy" />
            <FieldDescription>模型生成的草稿只包含正文，不包含脚本或其他可执行文件。</FieldDescription>
          </Field>
        </FieldGroup>
        <div class="skill-draft-preview">
          <div class="skill-draft-preview__header">
            <span>Markdown 预览</span>
            <Badge variant="outline">修订 {{ draftReview.draft?.revision || '-' }}</Badge>
          </div>
          <MarkdownContent :content="draftReview.form.content" :render-markdown="renderMarkdown" @notify="onMdNotify" />
        </div>
        <p v-if="draftReview.error" class="form-error" role="alert">{{ draftReview.error }}</p>
        <DialogFooter>
          <Button variant="ghost" @click="closeDraftReview">关闭</Button>
          <Button v-if="!draftReviewReadonly" variant="secondary" :disabled="draftReviewBusy" @click="saveDraftReview">
            <Save data-icon="inline-start" />
            <span>{{ draftReviewBusy ? '保存中…' : '保存草稿' }}</span>
          </Button>
          <Button v-if="!draftReviewReadonly && canPublishSkillDraft" variant="success" :disabled="draftReviewBusy" @click="confirmPublishDraft">
            <Send data-icon="inline-start" />
            <span>{{ draftReviewBusy ? '处理中…' : '发布 Skill' }}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { Eye, RefreshCw, Save, Send } from 'lucide-vue-next';

import PageLayout from '../components/PageLayout.vue';
import IconPlus from '../components/icons/IconPlus.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import EmptyState from '../components/EmptyState.vue';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../components/ui/field';
import { Badge } from '../components/ui/badge';
import KpiCards from '../components/admin/KpiCards.vue';
import MarkdownContent from '../components/chat/MarkdownContent.vue';
import { renderMarkdown } from '../utils/markdown';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { UiBadge } from '../components/ui';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import CustomSelect from '../components/ui/CustomSelect.vue';
import IconSearch from '../components/icons/IconSearch.vue';
import IconClose from '../components/icons/IconClose.vue';
import IconEdit from '../components/icons/IconEdit.vue';
import IconTrash from '../components/icons/IconTrash.vue';
import IconFile from '../components/icons/IconFile.vue';
import IconChevronDown from '../components/icons/IconChevronDown.vue';
import { useToast } from '../composables/useToast.js';
import { useConfirm } from '../composables/useConfirm.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { useEntityList } from '../composables/useEntityList.js';
import { useAuthStore } from '../stores/auth.js';
import {
  createSkill,
  deleteSkill,
  getSkillDetail,
  getSkillDraft,
  getSkillFileUrl,
  listSkillDrafts,
  listSkills,
  publishSkillDraft,
  updateSkillDraft,
  updateSkill,
  uploadSkillFiles,
} from '../api/skillLibrary.js';

const toast = useToast();
const { confirm } = useConfirm();
const authStore = useAuthStore();
const canPublishSkillDraft = computed(() => authStore.hasTenantRole('admin'));

const onMdNotify = ({ message, type }) => {
  if (type === 'success') toast.success(message);
  else toast.error(message);
};

const selected = ref(null);
const detailLoading = ref(false);
const detailError = ref('');

const { items: skills, loading, error, refresh } = useEntityList(
  async () => {
    const res = await listSkills();
    return res.data || [];
  },
  {
    errorPrefix: '加载 Skill 失败',
    onSuccess: async (items) => {
      if (items.length && !selected.value) {
        await selectSkill(items[0].name);
      }
    },
  },
);

const skillDrafts = ref([]);
const draftLoading = ref(false);
const draftError = ref('');
const draftReview = ref({
  open: false,
  error: '',
  draft: null,
  form: { name: '', description: '', content: '' },
});

const draftReviewReadonly = computed(() => draftReview.value.draft?.status === 'published');

async function loadDrafts() {
  draftLoading.value = true;
  draftError.value = '';
  try {
    skillDrafts.value = await listSkillDrafts();
  } catch (e) {
    draftError.value = e?.message || '加载 Skill 草稿失败';
  } finally {
    draftLoading.value = false;
  }
}

onMounted(loadDrafts);

function draftStatusLabel(status) {
  return status === 'published' ? '已发布' : '待审核';
}

function draftStatusVariant(status) {
  return status === 'published' ? 'success' : 'warning';
}

function formatDraftDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function openDraftReview(draft) {
  draftReview.value = {
    open: true,
    error: '',
    draft: { ...draft },
    form: { name: draft.name, description: draft.description, content: draft.content },
  };
  try {
    const loaded = await getSkillDraft(draft.id);
    draftReview.value.draft = loaded;
    draftReview.value.form = { name: loaded.name, description: loaded.description, content: loaded.content };
  } catch (e) {
    draftReview.value.error = e?.message || '加载草稿详情失败';
  }
}

function closeDraftReview() {
  draftReview.value.open = false;
  draftReview.value.error = '';
}

const { run: runSaveDraft, loading: draftSaveBusy } = useAsyncAction(
  async () => {
    const current = draftReview.value.draft;
    const saved = await updateSkillDraft(current.id, current.revision, draftReview.value.form);
    draftReview.value.draft = saved;
    draftReview.value.form = { name: saved.name, description: saved.description, content: saved.content };
    skillDrafts.value = skillDrafts.value.map((item) => item.id === saved.id ? saved : item);
    return saved;
  },
  {
    successMessage: 'Skill 草稿已保存',
    showErrorToast: false,
    onError: (e) => { draftReview.value.error = e?.message || '保存草稿失败'; },
  },
);

const { run: runPublishDraft, loading: draftPublishBusy } = useAsyncAction(
  async () => {
    const current = draftReview.value.draft;
    const published = await publishSkillDraft(current.id, current.revision);
    draftReview.value.draft = published;
    draftReview.value.form = { name: published.name, description: published.description, content: published.content };
    skillDrafts.value = skillDrafts.value.map((item) => item.id === published.id ? published : item);
    await refresh();
    return published;
  },
  {
    successMessage: 'Skill 已发布并加入可用清单',
    showErrorToast: false,
    onError: (e) => { draftReview.value.error = e?.message || '发布 Skill 失败'; },
  },
);

const draftReviewBusy = computed(() => draftSaveBusy.value || draftPublishBusy.value);

function saveDraftReview() {
  draftReview.value.error = '';
  runSaveDraft();
}

async function confirmPublishDraft() {
  const draft = draftReview.value.draft;
  if (!draft || draft.status === 'published' || !canPublishSkillDraft.value) return;
  const accepted = await confirm({
    title: '发布 Skill 草稿',
    message: `确认发布“${draftReview.value.form.name}”？发布后草稿不可再编辑，也不会自动绑定到任何 Agent。`,
    confirmText: '发布',
    danger: false,
  });
  if (!accepted) return;
  draftReview.value.error = '';
  runPublishDraft();
}

const countByType = computed(() => {
  const acc = { user_global: 0, builtin: 0, workspace: 0 };
  for (const s of skills.value) acc[s.source_type] = (acc[s.source_type] || 0) + 1;
  return acc;
});

const kpiItems = computed(() => [
  { key: 'total', label: 'Skill 总数', value: skills.value.length },
  { key: 'user', label: '用户全局（可编辑）', value: countByType.value.user_global },
  { key: 'builtin', label: '内置', value: countByType.value.builtin },
  { key: 'workspace', label: '工作区', value: countByType.value.workspace },
]);

const searchQuery = ref('');
const filteredSkills = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return skills.value;
  return skills.value.filter(
    (s) =>
      (s.display_name || s.name || '').toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q) ||
      (s.name || '').toLowerCase().includes(q),
  );
});

const groups = computed(() =>
  [
    { key: 'user_global', title: '用户全局（可编辑）', items: filteredSkills.value.filter((s) => s.source_type === 'user_global') },
    { key: 'workspace', title: '工作区', items: filteredSkills.value.filter((s) => s.source_type === 'workspace') },
    { key: 'builtin', title: '内置', items: filteredSkills.value.filter((s) => s.source_type === 'builtin') },
  ].filter((g) => g.items.length),
);

function isWritable(skill) {
  return skill.source_type === 'user_global';
}

// 来源类型 → 短标签 + 语义色（列表行徽章用）
const SOURCE_META = {
  user_global: { label: '用户', tone: 'success' },
  workspace: { label: '工作区', tone: 'info' },
  builtin: { label: '内置', tone: 'neutral' },
};
function sourceMeta(type) {
  return SOURCE_META[type] || SOURCE_META.builtin;
}

function fileUrl(p) {
  return getSkillFileUrl(selected.value.name, p);
}
function formatSize(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
const FILE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
const FOLDER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

// 文件树：扁平 files[{path,type,size}] → 按 '/' 构建层级；directory 可折叠
function buildFileTree(files) {
  const root = { name: '', path: '', type: 'directory', children: [] };
  for (const f of files || []) {
    const parts = String(f.path || '').split('/').filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1;
      const fullPath = parts.slice(0, i + 1).join('/');
      let child = node.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: fullPath, type: isLast ? f.type : 'directory', size: isLast ? f.size : null, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sortNodes = (nodes) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(root.children);
  return root.children;
}

const collapsedDirs = ref(new Set());
function toggleDir(path) {
  const next = new Set(collapsedDirs.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsedDirs.value = next;
}
const flatFiles = computed(() => {
  const tree = buildFileTree(selected.value?.files);
  const out = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const collapsed = n.type === 'directory' && collapsedDirs.value.has(n.path);
      out.push({ ...n, depth, collapsed });
      if (n.type === 'directory' && !collapsed) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
});

// 上传目录选项（CustomSelect）
const dirOptions = [
  { value: 'scripts', label: 'scripts/（Python 脚本）' },
  { value: '', label: 'Skill 根目录（资源文件）' },
];
const fileInputRef = ref(null);
function triggerFilePick() {
  fileInputRef.value?.click();
}

async function selectSkill(name) {
  detailLoading.value = true;
  detailError.value = '';
  try {
    const res = await getSkillDetail(name);
    selected.value = res.data;
  } catch (e) {
    detailError.value = e.message || '加载详情失败';
  } finally {
    detailLoading.value = false;
  }
}

const editor = ref({ open: false, mode: 'create', error: '', form: { name: '', description: '', content: '# ' } });
const editorTitle = computed(() =>
  editor.value.mode === 'create' ? '新建 Skill' : `编辑 ${selected.value ? selected.value.name : ''}`,
);

function openCreate() {
  editor.value = { open: true, mode: 'create', error: '', form: { name: '', description: '', content: '# ' } };
}
function openEdit() {
  const s = selected.value;
  editor.value = {
    open: true,
    mode: 'edit',
    error: '',
    form: { name: s.name, description: s.description, content: s.content },
  };
}
function closeEditor() {
  editor.value.open = false;
  editor.value.error = '';
}

const { run: runSave, loading: editorBusy } = useAsyncAction(
  async () => {
    if (editor.value.mode === 'create') {
      const res = await createSkill(editor.value.form);
      editor.value.open = false;
      await refresh();
      await selectSkill(res.data.name);
      return res;
    }
    const res = await updateSkill(selected.value.name, {
      description: editor.value.form.description,
      content: editor.value.form.content,
    });
    editor.value.open = false;
    await selectSkill(selected.value.name);
    return res;
  },
  {
    successMessage: 'Skill 已保存',
    showErrorToast: false,
    onError: (e) => {
      editor.value.error = e?.message || '保存失败';
    },
  },
);

function saveEditor() {
  editor.value.error = '';
  runSave();
}

const uploader = ref({ open: false, error: '', dir: 'scripts', files: [] });
const uploadTitle = computed(() => `上传文件到 ${selected.value ? selected.value.name : ''}`);

function openUpload() {
  uploader.value = { open: true, error: '', dir: 'scripts', files: [] };
}
function closeUploader() {
  uploader.value.open = false;
  uploader.value.error = '';
}
function onFileChange(e) {
  uploader.value.files = Array.from(e.target.files || []);
}
function clearFiles() {
  uploader.value.files = [];
  if (fileInputRef.value) fileInputRef.value.value = '';
}

const { run: runUpload, loading: uploaderBusy } = useAsyncAction(
  async () => {
    const res = await uploadSkillFiles(selected.value.name, uploader.value.files, uploader.value.dir);
    uploader.value.open = false;
    await selectSkill(selected.value.name);
    return res;
  },
  {
    successMessage: '文件已上传',
    showErrorToast: false,
    onError: (e) => {
      uploader.value.error = e?.message || '上传失败';
    },
  },
);

function doUpload() {
  uploader.value.error = '';
  runUpload();
}

const { run: runDelete, loading: deleting } = useAsyncAction(
  async () => {
    const res = await deleteSkill(selected.value.name);
    selected.value = null;
    await refresh();
    return res;
  },
  {
    onSuccess: (res) => {
      const purged = res?.data?.purged_agents?.length ?? 0;
      toast.success(purged > 0 ? `已删除 Skill，并从 ${purged} 个智能体配置中移除引用` : 'Skill 已删除');
    },
  },
);

async function confirmDelete() {
  const s = selected.value;
  if (!s) return;
  const ok = await confirm({ message: `确认删除 Skill “${s.name}”？此操作不可恢复。`, confirmText: '删除', danger: true });
  if (!ok) return;
  runDelete();
}
</script>

<style scoped>
.skill-lib {
  display: grid;
  grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
  gap: var(--spacing-xl);
  align-items: start;
  min-width: 0;
}
/* grid item 允许收缩：否则详情里的 markdown 正文/代码块会撑破面板，导致横向溢出 */
.skill-lib > * {
  min-width: 0;
}
@media (max-width: 900px) {
  .skill-lib {
    grid-template-columns: 1fr;
    gap: var(--spacing-md);
  }
}

/* 详情面板保证空状态最小高度（Card 自带 bg/radius/padding，不重复设）*/
.skill-detail-panel {
  min-height: 400px;
}

/* 列表搜索框 */
.skill-search {
  position: relative;
  display: flex;
  align-items: center;
  margin-bottom: var(--spacing-sm);
}
.skill-search__icon {
  position: absolute;
  left: 10px;
  color: var(--color-text-muted);
  pointer-events: none;
}
.skill-search__input {
  width: 100%;
  height: var(--control-height-md);
  padding: 0 32px 0 30px;
  border-radius: var(--control-radius);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.skill-search__input::placeholder {
  color: var(--color-text-muted);
}
.skill-search__input:focus {
  outline: none;
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.16);
}
.skill-search__clear {
  position: absolute;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.skill-search__clear:hover {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.skill-list-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: var(--spacing-lg);
}
.skill-list-group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-md) var(--spacing-md) var(--spacing-sm);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.skill-row {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm);
  width: 100%;
  text-align: left;
  padding: var(--spacing-md) var(--spacing-md);
  cursor: pointer;
  border: none;
  border-left: 2px solid transparent;
  background: transparent;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.skill-row:hover {
  background: var(--color-hover-overlay-md);
}
.skill-row--readonly {
  opacity: 0.65;
}
.skill-row--active {
  background: var(--color-active-bg);
  border-left-color: var(--color-brand-accent);
}
.skill-row__main {
  min-width: 0;
  flex: 1;
}
.skill-row__name-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  min-width: 0;
}
.skill-row__name {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.skill-row__desc {
  margin-top: 4px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.skill-detail__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
  margin-top: var(--spacing-sm);
}
.skill-detail__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
  flex-shrink: 0;
}
.skill-section {
  margin-top: var(--spacing-xl);
  padding-top: var(--spacing-xl);
  border-top: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  min-width: 0;
}
.skill-section:first-of-type {
  border-top: none;
  padding-top: 0;
}
.skill-section__title {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

/* 文件树（层级缩进 + 目录可折叠）*/
.skill-filetree {
  list-style: none;
  padding: 0;
  margin: 0;
}
.skill-file {
  font-size: var(--font-size-sm);
}
.skill-file__row {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  min-height: 28px;
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}
.skill-file__row--dir {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
}
.skill-file__row--dir:hover {
  background: var(--color-hover-overlay);
}
.skill-file__chevron {
  display: inline-flex;
  flex-shrink: 0;
  color: var(--color-text-muted);
  transform: rotate(-90deg);
  transition: transform var(--transition-fast);
}
.skill-file__chevron.is-open {
  transform: rotate(0deg);
}
.skill-file__icon {
  display: inline-flex;
  flex-shrink: 0;
  opacity: 0.6;
}
.skill-file__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-file__size {
  margin-left: auto;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  flex-shrink: 0;
}
.skill-file a {
  color: var(--color-brand-accent);
}
.skill-file a:hover {
  text-decoration: underline;
}

/* 上传文件选择器（包裹隐藏 input）*/
.skill-file-picker {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-height: var(--control-height-md);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--control-radius);
  border: 1px dashed var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: border-color var(--transition-fast), color var(--transition-fast);
}
.skill-file-picker:hover {
  border-color: var(--color-brand-accent);
  color: var(--color-text-primary);
}
.skill-file-picker__input {
  display: none;
}
.skill-file-picker__icon {
  flex-shrink: 0;
  color: var(--color-text-muted);
}
.skill-file-picker__list {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-primary);
}
.skill-file-picker__hint {
  color: var(--color-text-muted);
}

.skill-textarea {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  min-height: 240px !important;
  resize: vertical;
}

.skill-drafts {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  margin: var(--spacing-xl) 0;
  padding: var(--spacing-lg) 0;
  border-top: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
}
.skill-drafts__header,
.skill-draft-row,
.skill-drafts__state {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
}
.skill-drafts__title {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-lg);
  font-weight: 650;
}
.skill-drafts__description {
  margin: 4px 0 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
.skill-drafts__actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  flex-shrink: 0;
}
.skill-drafts__state {
  justify-content: flex-start;
  min-height: 56px;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
.skill-drafts__state--error {
  color: var(--color-error);
}
.skill-drafts__empty {
  min-height: 120px;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
}
.skill-drafts__list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}
.skill-draft-row {
  min-width: 0;
  padding: var(--spacing-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
}
.skill-draft-row__main {
  min-width: 0;
  flex: 1;
}
.skill-draft-row__title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
}
.skill-draft-row__name {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 650;
}
.skill-draft-row__revision,
.skill-draft-row__source {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
.skill-draft-row__description {
  margin: 4px 0 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
}
.skill-draft-row__source {
  margin: 4px 0 0;
  overflow-wrap: anywhere;
}
.skill-draft-form {
  gap: var(--spacing-md);
}
.skill-draft-preview {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  max-height: 260px;
  overflow: auto;
  padding: var(--spacing-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
}
.skill-draft-preview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
@media (max-width: 640px) {
  .skill-drafts__header,
  .skill-draft-row {
    align-items: flex-start;
  }
  .skill-draft-row {
    flex-direction: column;
  }
}
</style>
