<template>
  <PageLayout
    title="Skill 库"
    subtitle="管理领域技能：查看正文与脚本，新建、编辑、上传与删除。用户全局可写，内置/工作区只读。"
    content-padding="var(--spacing-lg)"
    mobile-content-padding="var(--spacing-sm)"
  >
    <template #header-actions>
      <UiButton variant="primary" :disabled="loading || editorBusy" @click="openCreate">
        <template #icon>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </template>
        新建 Skill
      </UiButton>
    </template>

    <KpiCards :items="kpiItems" />

    <div class="skill-lib">
      <EntityListLayout
        class="skill-list-panel"
        title="技能清单"
        description="按来源分组，点击查看详情"
        :loading="loading"
        loading-text="加载 Skill 中..."
        :error="error"
        empty-title="暂无 Skill"
        empty-hint="点“新建 Skill”创建第一个"
        :empty="!loading && !error && !skills.length"
        @retry="refresh"
      >
        <div class="adm-entity-list">
          <div v-for="group in groups" :key="group.key" class="skill-list-group">
            <div class="skill-list-group__head">
              <span>{{ group.title }}</span>
              <span class="adm-chip skill-list-group__count">{{ group.items.length }}</span>
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
                <div class="skill-row__name">{{ skill.display_name || skill.name }}</div>
                <div class="skill-row__desc">{{ skill.description }}</div>
              </div>
            </button>
          </div>
        </div>
      </EntityListLayout>

      <section class="adm-panel skill-detail-panel">
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
          <header class="adm-panel__header">
            <div class="adm-panel__title-block">
              <h2 class="adm-panel__title">{{ selected.display_name || selected.name }}</h2>
              <p class="adm-panel__description">{{ selected.description }}</p>
              <div class="skill-detail__chips">
                <span class="adm-chip">{{ selected.source_label }}</span>
                <span v-if="!selected.writable" class="adm-chip skill-chip--readonly">只读</span>
                <span v-else class="adm-chip skill-chip--editable">可编辑</span>
              </div>
            </div>
            <div v-if="selected.writable" class="adm-panel__actions">
              <UiButton variant="ghost" @click="openEdit">编辑正文</UiButton>
              <UiButton variant="ghost" @click="openUpload">上传脚本</UiButton>
              <UiButton variant="danger" :disabled="deleting" @click="confirmDelete">
                {{ deleting ? '删除中…' : '删除' }}
              </UiButton>
            </div>
          </header>

          <div v-if="selected.files.length" class="skill-section">
            <div class="skill-section__title">文件</div>
            <ul class="skill-filetree">
              <li
                v-for="f in selected.files"
                :key="f.path"
                :class="['skill-file', `skill-file--${f.type}`]"
              >
                <span class="skill-file__icon" v-html="fileIconSvg(f.type)"></span>
                <a v-if="f.type === 'file'" :href="fileUrl(f.path)" target="_blank" rel="noopener">{{ f.path }}</a>
                <span v-else>{{ f.path }}</span>
                <span v-if="f.type === 'file' && f.size != null" class="skill-file__size">{{ formatSize(f.size) }}</span>
              </li>
            </ul>
          </div>

          <div class="skill-section">
            <div class="skill-section__title">SKILL.md 正文</div>
            <div class="skill-prose" v-html="renderedContent"></div>
          </div>
        </template>
      </section>
    </div>

    <AdmModal :open="editor.open" :title="editorTitle" width="680px" @close="closeEditor">
      <div class="adm-form">
        <label v-if="editor.mode === 'create'" class="adm-field">
          <span class="adm-field-label">名称（小写字母 / 数字 / 连字符）</span>
          <input v-model.trim="editor.form.name" class="adm-form-control" placeholder="如 my-skill" />
        </label>
        <label v-if="editor.mode === 'create'" class="adm-field">
          <span class="adm-field-label">描述</span>
          <input v-model="editor.form.description" class="adm-form-control" placeholder="一句话说明适用场景" />
        </label>
        <label class="adm-field">
          <span class="adm-field-label">正文（Markdown）</span>
          <textarea v-model="editor.form.content" rows="14" class="adm-form-control skill-textarea"></textarea>
        </label>
        <p v-if="editor.error" class="adm-form-error">{{ editor.error }}</p>
      </div>
      <template #footer>
        <UiButton variant="ghost" @click="closeEditor">取消</UiButton>
        <UiButton variant="primary" :disabled="editorBusy" @click="saveEditor">
          {{ editorBusy ? '保存中…' : '保存' }}
        </UiButton>
      </template>
    </AdmModal>

    <AdmModal :open="uploader.open" :title="uploadTitle" @close="closeUploader">
      <div class="adm-form">
        <label class="adm-field">
          <span class="adm-field-label">目标目录</span>
          <select v-model="uploader.dir" class="adm-form-control">
            <option value="scripts">scripts/（Python 脚本）</option>
            <option value="">Skill 根目录（资源文件）</option>
          </select>
        </label>
        <label class="adm-field">
          <span class="adm-field-label">文件</span>
          <input type="file" multiple @change="onFileChange" />
        </label>
        <p v-if="uploader.error" class="adm-form-error">{{ uploader.error }}</p>
      </div>
      <template #footer>
        <UiButton variant="ghost" @click="closeUploader">取消</UiButton>
        <UiButton variant="primary" :disabled="uploaderBusy || !uploader.files.length" @click="doUpload">
          {{ uploaderBusy ? '上传中…' : '上传' }}
        </UiButton>
      </template>
    </AdmModal>
  </PageLayout>
</template>

<script setup>
import { computed, ref } from 'vue';
import MarkdownIt from 'markdown-it';

import PageLayout from '../components/PageLayout.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import AdmModal from '../components/admin/AdmModal.vue';
import KpiCards from '../components/admin/KpiCards.vue';
import { UiButton } from '../components/ui';
import { useToast } from '../composables/useToast.js';
import { useConfirm } from '../composables/useConfirm.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { useEntityList } from '../composables/useEntityList.js';
import {
  createSkill,
  deleteSkill,
  getSkillDetail,
  getSkillFileUrl,
  listSkills,
  updateSkill,
  uploadSkillFiles,
} from '../api/skillLibrary.js';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const toast = useToast();
const { confirm } = useConfirm();

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

const groups = computed(() =>
  [
    { key: 'user_global', title: '用户全局（可编辑）', items: skills.value.filter((s) => s.source_type === 'user_global') },
    { key: 'workspace', title: '工作区', items: skills.value.filter((s) => s.source_type === 'workspace') },
    { key: 'builtin', title: '内置', items: skills.value.filter((s) => s.source_type === 'builtin') },
  ].filter((g) => g.items.length),
);

const renderedContent = computed(() => md.render(selected.value ? selected.value.content : ''));

function isWritable(skill) {
  return skill.source_type === 'user_global';
}
function fileUrl(p) {
  return getSkillFileUrl(selected.value.name, p);
}
function formatSize(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
const FILE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
const FOLDER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
function fileIconSvg(type) {
  return type === 'directory' ? FOLDER_ICON : FILE_ICON;
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
@media (max-width: 900px) {
  .skill-lib {
    grid-template-columns: 1fr;
  }
}

.skill-list-panel {
  background: var(--color-bg-elevated);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.skill-detail-panel {
  background: var(--color-bg-elevated);
  border-radius: var(--radius-lg);
  min-height: 400px;
  padding: var(--spacing-xl);
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
.skill-list-group__count {
  font-weight: 500;
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
.skill-row__name {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 600;
  overflow-wrap: anywhere;
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
.skill-chip--editable {
  color: var(--color-success);
  background: var(--color-success-bg);
}
.skill-chip--readonly {
  color: var(--color-text-muted);
}
.skill-section {
  margin-top: var(--spacing-xl);
  padding-top: var(--spacing-xl);
  border-top: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
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

.skill-filetree {
  list-style: none;
  padding: 0;
  margin: 0;
}
.skill-file {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) 0;
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
}
.skill-file__icon {
  opacity: 0.6;
}
.skill-file__size {
  margin-left: auto;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
.skill-file a {
  color: var(--color-brand-accent);
  word-break: break-all;
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

.skill-prose {
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  line-height: 1.75;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.skill-prose :deep(h1),
.skill-prose :deep(h2),
.skill-prose :deep(h3),
.skill-prose :deep(h4) {
  margin: 1.4em 0 0.6em;
  line-height: 1.3;
  color: var(--color-text-primary);
}
.skill-prose :deep(h1) {
  font-size: 1.5em;
  font-weight: 700;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--color-border);
}
.skill-prose :deep(h2) {
  font-size: 1.3em;
  font-weight: 700;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--color-border);
}
.skill-prose :deep(h3) {
  font-size: 1.15em;
  font-weight: 600;
}
.skill-prose :deep(h4) {
  font-size: 1em;
  font-weight: 600;
}
.skill-prose :deep(p) {
  margin: 0.6em 0;
}
.skill-prose :deep(ul),
.skill-prose :deep(ol) {
  margin: 0.6em 0;
  padding-left: 1.6em;
}
.skill-prose :deep(li) {
  margin: 0.2em 0;
}
.skill-prose :deep(li)::marker {
  color: var(--color-text-secondary);
}
.skill-prose :deep(a) {
  color: var(--color-primary);
  text-decoration: none;
}
.skill-prose :deep(a:hover) {
  text-decoration: underline;
}
.skill-prose :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9em;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
}
.skill-prose :deep(pre) {
  margin: 0.8em 0;
  padding: var(--spacing-sm) var(--spacing-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  overflow-x: auto;
  max-width: 100%;
}
.skill-prose :deep(pre code) {
  padding: 0;
  background: transparent;
  border: none;
  font-size: 0.875em;
  line-height: 1.6;
}
.skill-prose :deep(blockquote) {
  margin: 0.8em 0;
  padding: 0.4em 1em;
  border-left: 3px solid var(--color-primary);
  background: var(--adm-surface-muted);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--color-text-secondary);
}
.skill-prose :deep(blockquote p) {
  margin: 0.3em 0;
}
.skill-prose :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.8em 0;
  font-size: 0.95em;
}
.skill-prose :deep(th),
.skill-prose :deep(td) {
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  text-align: left;
}
.skill-prose :deep(th) {
  background: var(--color-bg-secondary);
  font-weight: 600;
}
.skill-prose :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 1.4em 0;
}
.skill-prose :deep(img) {
  max-width: 100%;
  border-radius: var(--radius-md);
}
</style>
