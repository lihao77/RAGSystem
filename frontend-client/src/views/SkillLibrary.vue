<template>
  <PageLayout
    title="Skill 库"
    subtitle="由 Session Artifact 导入、审核并发布租户 Skill"
    mobile-content-padding="var(--spacing-sm)"
  >
    <KpiCards :items="kpiItems" />

    <section class="skill-drafts" aria-labelledby="skill-drafts-title">
      <div class="skill-drafts__header">
        <div>
          <h2 id="skill-drafts-title" class="skill-drafts__title">Skill 候选审核</h2>
          <p class="skill-drafts__description">Agent 或用户提交完整 Skill Artifact；发布后才会进入可用 Skill 清单。</p>
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
            <EmptyTitle>暂无 Skill 候选</EmptyTitle>
            <EmptyDescription>Session 中的 Skill Artifact 提交到 Skill 库后会出现在这里。</EmptyDescription>
        </EmptyHeader>
      </Empty>
      <div v-else class="skill-drafts__list">
        <div v-for="draft in skillDrafts" :key="draft.id" class="skill-draft-row">
          <div class="skill-draft-row__main">
            <div class="skill-draft-row__title">
              <span class="skill-draft-row__name">{{ draft.name }}</span>
              <Badge :variant="draftStatusVariant(draft)">{{ draftStatusLabel(draft) }}</Badge>
              <span class="skill-draft-row__revision">修订 {{ draft.revision }}</span>
            </div>
            <p class="skill-draft-row__description">{{ draft.description }}</p>
            <p class="skill-draft-row__source">
              {{ draft.source_agent_name || 'Artifact 提交' }}<span v-if="draft.source_session_id"> · 会话 {{ draft.source_session_id }}</span>
              <span v-if="draft.source_artifact_id"> · Artifact {{ draft.source_artifact_id }}@{{ draft.source_artifact_revision }}</span>
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
        empty-hint="在 Session 中生成 kind=skill Artifact 后提交候选"
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
                <UiBadge size="sm">发布包只读</UiBadge>
              </div>
            </div>
            <div v-if="selected.source_type === 'user_global'" class="skill-detail__actions">
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

    <Dialog :open="draftReview.open" @update:open="(v) => { if (!v) closeDraftReview() }">
      <DialogContent class="max-w-[900px]">
        <DialogHeader>
          <DialogTitle>{{ draftReview.form.name || 'Skill 候选审核' }}</DialogTitle>
          <DialogDescription>候选已经独立复制到 Skill 库，不会自动绑定到 Agent；管理员发布后才会成为正式 Skill。</DialogDescription>
        </DialogHeader>
        <FieldGroup class="skill-draft-form">
          <Field>
            <FieldLabel for="skill-draft-name">名称</FieldLabel>
            <Input id="skill-draft-name" v-model.trim="draftReview.form.name" disabled />
          </Field>
          <Field>
            <FieldLabel for="skill-draft-description">描述</FieldLabel>
            <Input id="skill-draft-description" v-model="draftReview.form.description" disabled />
          </Field>
          <Field>
            <FieldLabel for="skill-draft-content">SKILL.md 正文</FieldLabel>
            <Textarea id="skill-draft-content" v-model="draftReview.form.content" rows="12" class="skill-textarea" disabled />
            <FieldDescription>候选内容来自完整 Skill Artifact，包含 SKILL.md、脚本和资源文件。</FieldDescription>
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
          <Button
            v-if="draftReview.draft?.status !== 'published' && canPublishSkillDraft"
            variant="destructive"
            :disabled="draftReviewBusy"
            @click="confirmDeleteDraft"
          >
            <IconTrash :size="13" /><span>{{ draftDeleteBusy ? '删除中…' : '删除草稿' }}</span>
          </Button>
          <Button v-if="canRunSkillDraftPublish" variant="success" :disabled="draftReviewBusy" @click="confirmPublishDraft">
            <Send data-icon="inline-start" />
            <span>{{ draftReviewBusy ? '发布中…' : '发布 Skill' }}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { Eye, RefreshCw, Send } from 'lucide-vue-next';

import PageLayout from '../components/PageLayout.vue';
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
import IconSearch from '../components/icons/IconSearch.vue';
import IconClose from '../components/icons/IconClose.vue';
import IconTrash from '../components/icons/IconTrash.vue';
import IconChevronDown from '../components/icons/IconChevronDown.vue';
import { useToast } from '../composables/useToast.js';
import { useConfirm } from '../composables/useConfirm.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { useEntityList } from '../composables/useEntityList.js';
import { useAuthStore } from '../stores/auth.js';
import {
  deleteSkillDraft,
  deleteSkill,
  getSkillDetail,
  getSkillDraft,
  getSkillFileUrl,
  listSkillDrafts,
  listSkills,
  publishSkillDraft,
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

const canRunSkillDraftPublish = computed(() => canPublishSkillDraft.value
  && draftReview.value.draft?.status !== 'published'
  && (draftReview.value.draft?.bundle_assets?.length ?? 0) > 0);

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

function draftStatusLabel(draft) {
  if (draft.status !== 'published' && !draft.bundle_assets?.length) return '需重新提交 Artifact';
  if (draft.status === 'published' && draft.package_state === 'conflict') return '发布冲突';
  return draft.status === 'published' ? '已发布' : '待审核';
}

function draftStatusVariant(draft) {
  if (draft.status === 'published' && draft.package_state === 'conflict') return 'destructive';
  return draft.status === 'published' && draft.package_state !== 'missing' ? 'success' : 'warning';
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

const { run: runPublishDraft, loading: draftPublishBusy } = useAsyncAction(
  async () => {
    const current = draftReview.value.draft;
    try {
      const published = await publishSkillDraft(current.id, current.revision);
      draftReview.value.draft = published;
      draftReview.value.form = { name: published.name, description: published.description, content: published.content };
      skillDrafts.value = skillDrafts.value.map((item) => item.id === published.id ? published : item);
      await refresh();
      return published;
    } catch (error) {
      try {
        const latest = await getSkillDraft(current.id);
        if (draftReview.value.draft?.id === current.id) {
          draftReview.value.draft = latest;
          draftReview.value.form = { name: latest.name, description: latest.description, content: latest.content };
        }
        skillDrafts.value = skillDrafts.value.map((item) => item.id === latest.id ? latest : item);
      } catch {
        // Keep the original publish error when the server is still unavailable.
      }
      throw error;
    }
  },
  {
    successMessage: 'Skill 发布状态已确认',
    showErrorToast: false,
    onError: (e) => { draftReview.value.error = e?.message || '发布 Skill 失败'; },
  },
);

const { run: runDeleteDraft, loading: draftDeleteBusy } = useAsyncAction(
  async () => {
    const current = draftReview.value.draft;
    await deleteSkillDraft(current.id, current.revision);
    skillDrafts.value = skillDrafts.value.filter((item) => item.id !== current.id);
    closeDraftReview();
    return current;
  },
  {
    successMessage: 'Skill 草稿已删除',
    showErrorToast: false,
    onError: (e) => { draftReview.value.error = e?.message || '删除 Skill 草稿失败'; },
  },
);

const draftReviewBusy = computed(() => draftPublishBusy.value || draftDeleteBusy.value);

async function confirmDeleteDraft() {
  const draft = draftReview.value.draft;
  if (!draft || draft.status === 'published' || !canPublishSkillDraft.value) return;
  const accepted = await confirm({
    title: '删除 Skill 草稿',
    message: `确认删除“${draft.name}”？此操作不可恢复。`,
    confirmText: '删除',
    danger: true,
  });
  if (!accepted) return;
  draftReview.value.error = '';
  runDeleteDraft();
}

async function confirmPublishDraft() {
  const draft = draftReview.value.draft;
  if (!draft || !canPublishSkillDraft.value) return;
  const accepted = await confirm({
    title: '发布 Skill 候选',
    message: `确认发布“${draftReview.value.form.name}”？发布后候选不可再编辑，也不会自动绑定到任何 Agent。`,
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
  { key: 'user', label: '租户 Skill 包', value: countByType.value.user_global },
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
    { key: 'user_global', title: '租户发布包', items: filteredSkills.value.filter((s) => s.source_type === 'user_global') },
    { key: 'workspace', title: '工作区', items: filteredSkills.value.filter((s) => s.source_type === 'workspace') },
    { key: 'builtin', title: '内置', items: filteredSkills.value.filter((s) => s.source_type === 'builtin') },
  ].filter((g) => g.items.length),
);

function isWritable() {
  return false;
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

const { run: runDelete, loading: deleting } = useAsyncAction(
  async () => {
    const res = await deleteSkill(selected.value.name);
    selected.value = null;
    await Promise.allSettled([refresh(), loadDrafts()]);
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
  const ok = await confirm({
    message: `确认删除 Skill “${s.name}”？删除后其候选会恢复为可编辑状态。`,
    confirmText: '删除',
    danger: true,
  });
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
