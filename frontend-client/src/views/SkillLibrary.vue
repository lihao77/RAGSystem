<template>
  <PageLayout
    title="Skill 库"
    subtitle="管理领域技能：查看正文与脚本，新建、编辑、上传与删除。用户全局可写，内置/工作区只读。"
    content-padding="var(--spacing-lg)"
    mobile-content-padding="var(--spacing-sm)"
  >
    <template #header-actions>
      <button
        type="button"
        class="adm-action-btn adm-action-btn--success"
        :disabled="loading"
        @click="openCreate"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        新建 Skill
      </button>
    </template>

    <!-- KPI 统计 -->
    <section class="adm-kpi-grid">
      <article class="adm-kpi-card">
        <div class="adm-kpi-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        </div>
        <div class="adm-kpi-body">
          <span class="adm-kpi-label">Skill 总数</span>
          <strong class="adm-kpi-value">{{ skills.length }}</strong>
        </div>
      </article>
      <article class="adm-kpi-card">
        <div class="adm-kpi-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </div>
        <div class="adm-kpi-body">
          <span class="adm-kpi-label">用户全局（可编辑）</span>
          <strong class="adm-kpi-value">{{ countByType.user_global }}</strong>
        </div>
      </article>
      <article class="adm-kpi-card">
        <div class="adm-kpi-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
        </div>
        <div class="adm-kpi-body">
          <span class="adm-kpi-label">内置</span>
          <strong class="adm-kpi-value">{{ countByType.builtin }}</strong>
        </div>
      </article>
      <article class="adm-kpi-card">
        <div class="adm-kpi-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </div>
        <div class="adm-kpi-body">
          <span class="adm-kpi-label">工作区</span>
          <strong class="adm-kpi-value">{{ countByType.workspace }}</strong>
        </div>
      </article>
    </section>

    <!-- 两栏：列表 + 详情 -->
    <div class="skill-lib">
      <aside class="adm-panel skill-list-panel">
        <header class="adm-panel__header">
          <div class="adm-panel__title-block">
            <h2 class="adm-panel__title">技能清单</h2>
            <p class="adm-panel__description">按来源分组，点击查看详情</p>
          </div>
        </header>
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
          <div v-if="!loading && !skills.length" class="adm-state">
            <p class="adm-state__title">暂无 Skill</p>
            <p class="adm-state__hint">点“新建 Skill”创建第一个</p>
          </div>
        </div>
      </aside>

      <section class="adm-panel skill-detail-panel">
        <div v-if="loading" class="adm-state">加载中…</div>
        <div v-else-if="error" class="adm-state adm-state--error">{{ error }}</div>
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
              <button type="button" class="adm-action-btn" @click="openEdit">编辑正文</button>
              <button type="button" class="adm-action-btn" @click="openUpload">上传脚本</button>
              <button type="button" class="adm-action-btn adm-action-btn--danger" @click="confirmDelete">删除</button>
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
                <span class="skill-file__icon">{{ f.type === 'directory' ? '📁' : '📄' }}</span>
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

    <!-- 新建 / 编辑 modal -->
    <div v-if="editor.open" class="skill-overlay" @click.self="closeEditor">
      <div class="adm-modal skill-modal">
        <div class="adm-modal-header">
          <h3>{{ editor.mode === 'create' ? '新建 Skill' : '编辑 ' + (selected ? selected.name : '') }}</h3>
        </div>
        <div class="adm-modal-body">
          <label v-if="editor.mode === 'create'" class="field">
            <span>名称（小写字母 / 数字 / 连字符）</span>
            <input v-model="editor.form.name" placeholder="如 my-skill" />
          </label>
          <label v-if="editor.mode === 'create'" class="field">
            <span>描述</span>
            <input v-model="editor.form.description" placeholder="一句话说明适用场景" />
          </label>
          <label class="field">
            <span>正文（Markdown）</span>
            <textarea v-model="editor.form.content" rows="14" class="skill-textarea"></textarea>
          </label>
        </div>
        <div class="adm-modal-footer">
          <button type="button" class="adm-action-btn" @click="closeEditor">取消</button>
          <button type="button" class="adm-action-btn adm-action-btn--success" :disabled="editor.busy" @click="saveEditor">
            {{ editor.busy ? '保存中…' : '保存' }}
          </button>
        </div>
        <p v-if="editor.error" class="adm-form-error skill-modal__error">{{ editor.error }}</p>
      </div>
    </div>

    <!-- 上传脚本 modal -->
    <div v-if="uploader.open" class="skill-overlay" @click.self="closeUploader">
      <div class="adm-modal skill-modal">
        <div class="adm-modal-header">
          <h3>上传文件到 {{ selected ? selected.name : '' }}</h3>
        </div>
        <div class="adm-modal-body">
          <label class="field">
            <span>目标目录</span>
            <select v-model="uploader.dir" class="adm-form-control">
              <option value="scripts">scripts/（Python 脚本）</option>
              <option value="">Skill 根目录（资源文件）</option>
            </select>
          </label>
          <label class="field">
            <span>文件</span>
            <input type="file" multiple @change="onFileChange" />
          </label>
        </div>
        <div class="adm-modal-footer">
          <button type="button" class="adm-action-btn" @click="closeUploader">取消</button>
          <button
            type="button"
            class="adm-action-btn adm-action-btn--success"
            :disabled="uploader.busy || !uploader.files.length"
            @click="doUpload"
          >
            {{ uploader.busy ? '上传中…' : '上传' }}
          </button>
        </div>
        <p v-if="uploader.error" class="adm-form-error skill-modal__error">{{ uploader.error }}</p>
      </div>
    </div>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import MarkdownIt from 'markdown-it';

import PageLayout from '../components/PageLayout.vue';
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

const loading = ref(true);
const error = ref('');
const skills = ref([]);
const selected = ref(null);

const countByType = computed(() => {
  const acc = { user_global: 0, builtin: 0, workspace: 0 };
  for (const s of skills.value) acc[s.source_type] = (acc[s.source_type] || 0) + 1;
  return acc;
});

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

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const res = await listSkills();
    skills.value = res.data || [];
    if (skills.value.length && !selected.value) {
      await selectSkill(skills.value[0].name);
    }
  } catch (e) {
    error.value = e.message || '加载失败';
  } finally {
    loading.value = false;
  }
}

async function selectSkill(name) {
  try {
    const res = await getSkillDetail(name);
    selected.value = res.data;
  } catch (e) {
    error.value = e.message || '加载详情失败';
  }
}

const editor = ref({ open: false, mode: 'create', busy: false, error: '', form: { name: '', description: '', content: '# ' } });

function openCreate() {
  editor.value = { open: true, mode: 'create', busy: false, error: '', form: { name: '', description: '', content: '# ' } };
}
function openEdit() {
  const s = selected.value;
  editor.value = {
    open: true,
    mode: 'edit',
    busy: false,
    error: '',
    form: { name: s.name, description: s.description, content: s.content },
  };
}
function closeEditor() {
  editor.value.open = false;
}
async function saveEditor() {
  editor.value.busy = true;
  editor.value.error = '';
  try {
    if (editor.value.mode === 'create') {
      const res = await createSkill(editor.value.form);
      await load();
      await selectSkill(res.data.name);
    } else {
      await updateSkill(selected.value.name, {
        description: editor.value.form.description,
        content: editor.value.form.content,
      });
      await selectSkill(selected.value.name);
    }
    editor.value.open = false;
  } catch (e) {
    editor.value.error = e.message || '保存失败';
  } finally {
    editor.value.busy = false;
  }
}

const uploader = ref({ open: false, busy: false, error: '', dir: 'scripts', files: [] });
function openUpload() {
  uploader.value = { open: true, busy: false, error: '', dir: 'scripts', files: [] };
}
function closeUploader() {
  uploader.value.open = false;
}
function onFileChange(e) {
  uploader.value.files = Array.from(e.target.files || []);
}
async function doUpload() {
  uploader.value.busy = true;
  uploader.value.error = '';
  try {
    await uploadSkillFiles(selected.value.name, uploader.value.files, uploader.value.dir);
    await selectSkill(selected.value.name);
    uploader.value.open = false;
  } catch (e) {
    uploader.value.error = e.message || '上传失败';
  } finally {
    uploader.value.busy = false;
  }
}

async function confirmDelete() {
  const s = selected.value;
  if (!s) return;
  if (!window.confirm(`确认删除 Skill “${s.name}”？此操作不可恢复。`)) return;
  try {
    const res = await deleteSkill(s.name);
    selected.value = null;
    await load();
    const purged = res?.data?.purged_agents?.length ?? 0;
    if (purged > 0) {
      window.alert(`已删除 Skill“${s.name}”，并从 ${purged} 个智能体配置中移除引用。`);
    }
  } catch (e) {
    error.value = e.message || '删除失败';
  }
}

onMounted(load);
</script>

<style scoped>
.skill-lib {
  display: grid;
  grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
  gap: var(--spacing-md);
  align-items: start;
  min-width: 0;
  margin-top: var(--spacing-md);
}
@media (max-width: 900px) {
  .skill-lib {
    grid-template-columns: 1fr;
  }
}

.skill-list-panel,
.skill-detail-panel {
  padding: var(--spacing-md);
}
.skill-detail-panel {
  min-height: 320px;
}

/* 列表分组与行 */
.skill-list-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.skill-list-group__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 4px 2px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.skill-list-group__count {
  padding: 2px 8px;
  font-weight: 600;
}
.skill-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  cursor: pointer;
}
.skill-row--readonly {
  opacity: 0.72;
}
.skill-row--active {
  border-color: var(--adm-accent-border);
  background: var(--adm-control-active);
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
  margin-top: 2px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.4;
  overflow-wrap: anywhere;
}

/* 详情 */
.skill-detail__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.skill-chip--editable {
  color: var(--color-success);
  border-color: rgba(var(--color-success-rgb), 0.3);
  background: rgba(var(--color-success-rgb), 0.08);
}
.skill-chip--readonly {
  color: var(--color-text-muted);
}
.skill-section {
  margin-top: var(--spacing-md);
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.skill-section__title {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

/* 文件树 */
.skill-filetree {
  list-style: none;
  padding: 0;
  margin: 0;
}
.skill-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
}
.skill-file__icon {
  opacity: 0.7;
}
.skill-file__size {
  margin-left: auto;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
.skill-file a {
  color: var(--color-primary);
  word-break: break-all;
}
.skill-file a:hover {
  text-decoration: underline;
}

/* SKILL.md 正文 —— 文档化排版，全 token，双主题自适应 */
.skill-prose {
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  line-height: 1.7;
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

/* 遮罩与模态 */
.skill-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: var(--spacing-md);
}
.skill-modal {
  width: min(680px, 100%);
  max-height: 88vh;
  overflow-y: auto;
  padding: var(--spacing-md) var(--spacing-lg);
}
.skill-modal__error {
  margin-top: var(--spacing-sm);
}
.skill-textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--font-size-sm);
  min-height: 240px !important;
  resize: vertical;
}
</style>
