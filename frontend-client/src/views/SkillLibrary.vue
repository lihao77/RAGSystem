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

    <div class="skill-workbench" aria-label="Skill 管理工作区">
        <Card class="skill-list-card">
          <CardHeader class="skill-navigator__head">
            <div class="navigator-heading">
              <CardTitle>Skill 管理</CardTitle>
              <CardDescription>选择 Draft 编辑，或查看系统可用 Skill。</CardDescription>
            </div>
            <Tabs :model-value="navigatorTab" @update:model-value="changeNavigatorTab">
              <TabsList class="skill-navigator__tabs">
                <TabsTrigger value="drafts">Draft</TabsTrigger>
                <TabsTrigger value="library">Skill 库</TabsTrigger>
              </TabsList>
            </Tabs>
            <Input v-model="searchQuery" class="skill-navigator__search" :placeholder="navigatorTab === 'drafts' ? '搜索 Draft' : '搜索 Skill'" />
          </CardHeader>

          <CardContent class="skill-navigator__body">
            <div v-if="navigatorLoading" class="navigator-state">
              <Spinner />
              <span>加载中</span>
            </div>
            <div v-else-if="navigatorError" class="navigator-state navigator-state--error" role="alert">
              <strong>加载失败</strong>
              <span>{{ navigatorError }}</span>
              <Button variant="outline" size="sm" @click="handleRefresh">重试</Button>
            </div>

            <template v-else-if="navigatorTab === 'drafts'">
              <Empty v-if="!filteredDrafts.length" class="navigator-empty">
                <EmptyHeader>
                  <EmptyTitle>{{ searchQuery ? '没有匹配的 Draft' : '暂无 Skill Draft' }}</EmptyTitle>
                </EmptyHeader>
              </Empty>
              <button
                v-for="draft in filteredDrafts"
                v-else
                :key="draft.id"
                type="button"
                :class="['navigator-row', { 'navigator-row--active': activeKind === 'draft' && activeKey === draft.id }]"
                @click="selectDraft(draft)"
              >
                <div class="navigator-row__title">
                  <span class="navigator-row__name">{{ draft.name }}</span>
                  <Badge :variant="draftStatusVariant(draft)">{{ draftStatusLabel(draft) }}</Badge>
                </div>
                <p>{{ draft.description }}</p>
                <div class="navigator-row__meta">
                  <span>修订 {{ draft.revision }}</span>
                  <span>{{ formatCompactDate(draft.updated_at) }}</span>
                </div>
              </button>
            </template>

            <template v-else>
              <Empty v-if="!filteredSkillGroups.length" class="navigator-empty">
                <EmptyHeader>
                  <EmptyTitle>{{ searchQuery ? '没有匹配的 Skill' : '暂无可用 Skill' }}</EmptyTitle>
                </EmptyHeader>
              </Empty>
              <div v-for="group in filteredSkillGroups" v-else :key="group.key" class="navigator-group">
                <div class="navigator-group__label">
                  <span>{{ group.label }}</span>
                  <Badge variant="secondary">{{ group.items.length }}</Badge>
                </div>
                <button
                  v-for="skill in group.items"
                  :key="skill.name"
                  type="button"
                  :class="['navigator-row', { 'navigator-row--active': activeKind === 'skill' && activeKey === skill.name }]"
                  @click="selectSkill(skill)"
                >
                  <div class="navigator-row__title">
                    <span class="navigator-row__name">{{ skill.display_name || skill.name }}</span>
                    <Badge variant="outline">{{ sourceLabel(skill.source_type) }}</Badge>
                  </div>
                  <p>{{ skill.description }}</p>
                </button>
              </div>
            </template>
          </CardContent>
        </Card>

      <Card class="skill-workspace-card">
        <main class="skill-workspace">
          <div v-if="workspaceLoading" class="workspace-state">
            <Spinner />
            <span>加载工作区</span>
          </div>

          <div v-else-if="workspaceError && !activeDraft && !selectedSkill" class="workspace-state workspace-state--error" role="alert">
            <strong>无法打开 Skill</strong>
            <span>{{ workspaceError }}</span>
          </div>

          <Empty v-else-if="!activeDraft && !selectedSkill" class="workspace-state">
            <EmptyHeader>
              <EmptyTitle>选择一个 Skill</EmptyTitle>
            </EmptyHeader>
          </Empty>

          <template v-else-if="activeKind === 'draft' && activeDraft">
            <header class="workspace-header">
              <div class="workspace-header__identity">
                <div class="workspace-header__title-row">
                  <h2>{{ activeDraft.name }}</h2>
                  <Badge :variant="draftStatusVariant(activeDraft)">{{ draftStatusLabel(activeDraft) }}</Badge>
                  <Badge variant="outline">修订 {{ activeDraft.revision }}</Badge>
                </div>
                <p>{{ activeDraft.description }}</p>
                <span>{{ draftOrigin(activeDraft) }} · 更新于 {{ formatDraftDate(activeDraft.updated_at) }}</span>
              </div>
              <div class="workspace-header__actions">
                <Button
                  v-if="canEditSkillDraft && workspaceTab === 'overview'"
                  variant="outline"
                  size="sm"
                  :disabled="mutationBusy || !overviewDirty"
                  @click="saveOverview"
                >
                  <Spinner v-if="overviewSaving" data-icon="inline-start" />
                  <Save v-else data-icon="inline-start" />
                  保存
                </Button>
                <Button
                  v-if="canEditSkillDraft && (activeDraft.status !== 'published' || activeDraft.package_state === 'missing')"
                  variant="success"
                  size="sm"
                  :disabled="mutationBusy || hasUnsavedChanges || !activeDraft.bundle_assets?.length"
                  @click="publishDraft"
                >
                  <Spinner v-if="publishing" data-icon="inline-start" />
                  <Send v-else data-icon="inline-start" />
                  {{ activeDraft.package_state === 'missing' ? '修复发布' : '发布' }}
                </Button>
                <Button
                  v-if="canEditSkillDraft"
                  variant="ghost"
                  size="icon-sm"
                  :disabled="mutationBusy"
                  aria-label="删除 Draft"
                  title="删除 Draft，不影响已发布 Skill"
                  @click="deleteDraft"
                >
                  <Trash2 data-icon="inline-start" />
                </Button>
              </div>
            </header>

            <div v-if="workspaceError" class="workspace-message" role="alert">
              <span>{{ workspaceError }}</span>
            </div>

            <div class="workspace-tabbar">
              <Tabs :model-value="workspaceTab" class="workspace-tabs" @update:model-value="changeWorkspaceTab">
                <TabsList>
                  <TabsTrigger value="overview">基本信息</TabsTrigger>
                  <TabsTrigger value="files">Bundle 文件</TabsTrigger>
                </TabsList>
              </Tabs>
              <Tabs v-if="workspaceTab === 'overview'" v-model="overviewMode" class="overview-mode-tabs">
                <TabsList>
                  <TabsTrigger value="edit">编辑</TabsTrigger>
                  <TabsTrigger value="preview">预览</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            <div v-if="workspaceTab === 'overview'" class="overview-pane">
              <div v-if="overviewMode === 'edit'" class="overview-editor">
                <FieldGroup>
                  <Field :data-disabled="!canEditSkillDraft || draftNameLocked || mutationBusy">
                    <FieldLabel for="draft-name">名称</FieldLabel>
                    <Input id="draft-name" v-model.trim="draftForm.name" :disabled="!canEditSkillDraft || draftNameLocked || mutationBusy" />
                    <FieldDescription v-if="draftNameLocked">已发布 Skill 的名称保持不变。</FieldDescription>
                  </Field>
                  <Field :data-disabled="!canEditSkillDraft || mutationBusy">
                    <FieldLabel for="draft-description">描述</FieldLabel>
                    <Input id="draft-description" v-model="draftForm.description" :disabled="!canEditSkillDraft || mutationBusy" />
                  </Field>
                  <Field :data-disabled="!canEditSkillDraft || mutationBusy">
                    <div class="field-heading">
                      <FieldLabel for="draft-content">SKILL.md 正文</FieldLabel>
                      <span>{{ draftForm.content.length.toLocaleString() }} / 30,000</span>
                    </div>
                    <Textarea id="draft-content" v-model="draftForm.content" class="overview-textarea" :disabled="!canEditSkillDraft || mutationBusy" />
                    <FieldDescription>结构化编辑会保留 SKILL.md 中的其他 frontmatter；源文件可在 Bundle 文件中直接修改。</FieldDescription>
                  </Field>
                </FieldGroup>
              </div>
              <section v-else class="overview-preview" aria-label="Markdown 预览">
                <div class="pane-heading">
                  <div>
                    <strong>SKILL.md</strong>
                    <span>正文渲染结果</span>
                  </div>
                  <Eye />
                </div>
                <div class="overview-preview__body">
                  <MarkdownContent :content="draftForm.content" :render-markdown="renderMarkdown" @notify="onMdNotify" />
                </div>
              </section>
            </div>

            <div v-else class="bundle-pane">
              <aside class="bundle-tree">
                <div class="pane-heading">
                  <div>
                    <strong>文件</strong>
                    <span>{{ activeDraft.bundle_assets.length }} 个文件 · {{ formatSize(bundleSize) }}</span>
                  </div>
                  <div v-if="canEditSkillDraft" class="pane-heading__actions">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      :disabled="mutationBusy"
                      aria-label="新建文本文件"
                      title="新建文本文件"
                      @click="openCreateFile"
                    >
                      <FilePlus2 data-icon="inline-start" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      :disabled="mutationBusy"
                      aria-label="上传文件"
                      title="上传或替换文件"
                      @click="openFilePicker"
                    >
                      <Upload data-icon="inline-start" />
                    </Button>
                    <input ref="fileInput" class="sr-only" type="file" @change="uploadSelectedFile" />
                  </div>
                </div>
                <div class="file-tree-scroll">
                  <button
                    v-for="node in draftFileTree"
                    :key="node.path"
                    type="button"
                    :class="['file-row', { 'file-row--active': node.type === 'file' && selectedFilePath === node.path }]"
                    :style="{ paddingLeft: `${10 + node.depth * 16}px` }"
                    @click="node.type === 'directory' ? toggleDirectory(node.path) : selectDraftFile(node.path)"
                  >
                    <ChevronDown v-if="node.type === 'directory'" :class="['file-row__chevron', { 'file-row__chevron--closed': node.collapsed }]" />
                    <FileText v-if="node.type === 'file'" />
                    <span>{{ node.name }}</span>
                    <small v-if="node.type === 'file' && node.size != null">{{ formatSize(node.size) }}</small>
                  </button>
                </div>
              </aside>

              <section class="file-editor">
                <div v-if="fileLoading" class="workspace-state">
                  <Spinner />
                  <span>读取文件</span>
                </div>
                <Empty v-else-if="!selectedFile" class="workspace-state">
                  <EmptyHeader>
                    <EmptyTitle>选择一个文件</EmptyTitle>
                  </EmptyHeader>
                </Empty>
                <template v-else>
                  <div class="file-editor__toolbar">
                    <div class="file-editor__identity">
                      <strong>{{ selectedFile.relative_path }}</strong>
                      <span>{{ selectedFile.media_type }} · {{ formatSize(selectedFile.size) }}</span>
                    </div>
                    <div class="file-editor__actions">
                      <Button variant="outline" size="sm" @click="downloadDraftFile">
                        <Download data-icon="inline-start" />
                        下载
                      </Button>
                      <Button
                        v-if="canEditSkillDraft && editableSelectedFile"
                        size="sm"
                        :disabled="mutationBusy || !fileDirty"
                        @click="saveSelectedFile"
                      >
                        <Spinner v-if="fileSaving" data-icon="inline-start" />
                        <Save v-else data-icon="inline-start" />
                        保存文件
                      </Button>
                      <Button
                        v-if="canEditSkillDraft && selectedFile.relative_path !== 'SKILL.md'"
                        variant="ghost"
                        size="icon-sm"
                        :disabled="mutationBusy"
                        aria-label="删除文件"
                        title="从 Draft bundle 删除"
                        @click="deleteSelectedFile"
                      >
                        <Trash2 data-icon="inline-start" />
                      </Button>
                    </div>
                  </div>
                  <Textarea
                    v-if="editableSelectedFile"
                    v-model="fileText"
                    class="file-source-editor"
                    :disabled="!canEditSkillDraft || mutationBusy"
                    spellcheck="false"
                  />
                  <div v-else class="binary-file-state">
                    <FileText />
                    <strong>此文件不在网页中直接编辑</strong>
                    <span>可下载检查，或使用“上传文件”选择同名文件替换。</span>
                  </div>
                </template>
              </section>
            </div>
          </template>

          <template v-else-if="selectedSkill">
            <header class="workspace-header">
              <div class="workspace-header__identity">
                <div class="workspace-header__title-row">
                  <h2>{{ selectedSkill.display_name || selectedSkill.name }}</h2>
                  <Badge variant="outline">{{ sourceLabel(selectedSkill.source_type) }}</Badge>
                </div>
                <p>{{ selectedSkill.description }}</p>
                <span>{{ selectedSkill.name }} · {{ publishedFileCount }} 个文件</span>
              </div>
              <div v-if="selectedSkill.source_type === 'user_global' && canEditSkillDraft" class="workspace-header__actions">
                <Button variant="outline" size="sm" :disabled="mutationBusy" @click="editPublishedSkill">
                  <Spinner v-if="restoringDraft" data-icon="inline-start" />
                  <FilePenLine v-else data-icon="inline-start" />
                  编辑 Draft
                </Button>
                <Button variant="destructive" size="sm" :disabled="mutationBusy" @click="deletePublishedSkill">
                  <Trash2 data-icon="inline-start" />
                  删除 Skill
                </Button>
              </div>
            </header>

            <div v-if="workspaceError" class="workspace-message" role="alert">
              <span>{{ workspaceError }}</span>
            </div>

            <div class="published-pane">
              <Tabs v-model="publishedTab" class="published-tabs">
                <TabsList>
                  <TabsTrigger value="overview">说明</TabsTrigger>
                  <TabsTrigger value="files">文件 <span class="published-tabs__count">{{ publishedFileCount }}</span></TabsTrigger>
                </TabsList>
              </Tabs>
              <section v-if="publishedTab === 'overview'" class="published-content">
                <div class="pane-heading">
                  <div>
                    <strong>SKILL.md</strong>
                    <span>已发布正文</span>
                  </div>
                </div>
                <div class="published-content__body">
                  <MarkdownContent :content="selectedSkill.content" :render-markdown="renderMarkdown" @notify="onMdNotify" />
                </div>
              </section>
              <section v-else class="published-files">
                <div class="pane-heading">
                  <div>
                    <strong>已发布文件</strong>
                    <span>只读 bundle</span>
                  </div>
                </div>
                <div class="published-file-tree">
                  <template v-for="node in publishedFileTree" :key="node.path">
                    <button
                      v-if="node.type === 'directory'"
                      type="button"
                      class="file-row published-file-row"
                      :style="{ paddingLeft: `${10 + node.depth * 16}px` }"
                      @click="togglePublishedDirectory(node.path)"
                    >
                      <ChevronDown :class="['file-row__chevron', { 'file-row__chevron--closed': node.collapsed }]" />
                      <span>{{ node.name }}</span>
                    </button>
                    <a
                      v-else
                      :href="getSkillFileUrl(selectedSkill.name, node.path)"
                      target="_blank"
                      rel="noopener"
                      class="file-row published-file-row"
                      :style="{ paddingLeft: `${10 + node.depth * 16}px` }"
                    >
                      <FileText />
                      <span>{{ node.name }}</span>
                      <small>{{ formatSize(node.size) }}</small>
                    </a>
                  </template>
                </div>
              </section>
            </div>
          </template>
        </main>
      </Card>
    </div>

    <Dialog :open="createDraftDialog.open" @update:open="(open) => { if (!open) closeCreateDraft() }">
      <DialogContent class="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>新建 Skill Draft</DialogTitle>
          <DialogDescription>创建基础 SKILL.md 后，可继续添加脚本和资源文件。</DialogDescription>
        </DialogHeader>
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
        <p v-if="createDraftDialog.error" class="dialog-error" role="alert">{{ createDraftDialog.error }}</p>
        <DialogFooter>
          <Button variant="ghost" :disabled="creatingDraft" @click="closeCreateDraft">取消</Button>
          <Button :disabled="creatingDraft || !canCreateDraft" @click="createDraft">
            <Spinner v-if="creatingDraft" data-icon="inline-start" />
            <Plus v-else data-icon="inline-start" />
            创建 Draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="createFileDialog.open" @update:open="(open) => { if (!open) closeCreateFile() }">
      <DialogContent class="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>新建文本文件</DialogTitle>
          <DialogDescription>路径相对于 Skill bundle 根目录，例如 scripts/check.py。</DialogDescription>
        </DialogHeader>
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
        <p v-if="createFileDialog.error" class="dialog-error" role="alert">{{ createFileDialog.error }}</p>
        <DialogFooter>
          <Button variant="ghost" :disabled="fileSaving" @click="closeCreateFile">取消</Button>
          <Button :disabled="fileSaving || !canCreateFile" @click="createTextFile">
            <Spinner v-if="fileSaving" data-icon="inline-start" />
            <FilePlus2 v-else data-icon="inline-start" />
            创建文件
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import {
  ChevronDown,
  Download,
  Eye,
  FilePenLine,
  FilePlus2,
  FileText,
  Plus,
  RefreshCw,
  Save,
  Send,
  Trash2,
  Upload,
} from 'lucide-vue-next';

import PageLayout from '../components/PageLayout.vue';
import MarkdownContent from '../components/chat/MarkdownContent.vue';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Empty, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Textarea } from '../components/ui/textarea';
import { useConfirm } from '../composables/useConfirm.js';
import { useToast } from '../composables/useToast.js';
import { useAuthStore } from '../stores/auth.js';
import { renderMarkdown } from '../utils/markdown';
import {
  createSkillDraft,
  deleteSkill,
  deleteSkillDraft,
  deleteSkillDraftFile,
  ensureSkillDraft,
  getSkillDetail,
  getSkillDraft,
  getSkillDraftFile,
  getSkillFileUrl,
  listSkillDrafts,
  listSkills,
  publishSkillDraft,
  putSkillDraftFile,
  updateSkillDraft,
} from '../api/skillLibrary.js';

const toast = useToast();
const { confirm } = useConfirm();
const authStore = useAuthStore();
const canEditSkillDraft = computed(() => authStore.hasTenantRole('admin'));

const skills = ref([]);
const skillDrafts = ref([]);
const loadingAll = ref(false);
const skillsLoading = ref(false);
const draftsLoading = ref(false);
const skillsError = ref('');
const draftsError = ref('');
const navigatorTab = ref('drafts');
const searchQuery = ref('');
const activeKind = ref('');
const activeKey = ref('');
const activeDraft = ref(null);
const selectedSkill = ref(null);
const workspaceLoading = ref(false);
const workspaceError = ref('');
const workspaceTab = ref('overview');
const overviewMode = ref('edit');
const draftForm = ref({ name: '', description: '', content: '' });
const overviewSaving = ref(false);
const publishing = ref(false);
const deletingDraft = ref(false);
const deletingSkill = ref(false);
const restoringDraft = ref(false);
const creatingDraft = ref(false);
const fileLoading = ref(false);
const fileSaving = ref(false);
const fileDeleting = ref(false);
const selectedFilePath = ref('');
const selectedFile = ref(null);
const fileText = ref('');
const originalFileText = ref('');
const fileInput = ref(null);
const collapsedDirectories = ref(new Set());
const publishedCollapsedDirectories = ref(new Set());
const createDraftDialog = ref({ open: false, name: '', description: '', error: '' });
const createFileDialog = ref({ open: false, path: '', content: '', error: '' });
const publishedTab = ref('overview');

const navigatorLoading = computed(() => navigatorTab.value === 'drafts' ? draftsLoading.value : skillsLoading.value);
const navigatorError = computed(() => navigatorTab.value === 'drafts' ? draftsError.value : skillsError.value);
const draftNameLocked = computed(() => Boolean(activeDraft.value?.published_at));
const overviewDirty = computed(() => Boolean(activeDraft.value) && (
  draftForm.value.name !== activeDraft.value.name
  || draftForm.value.description !== activeDraft.value.description
  || draftForm.value.content !== activeDraft.value.content
));
const fileDirty = computed(() => editableSelectedFile.value && fileText.value !== originalFileText.value);
const hasUnsavedChanges = computed(() => overviewDirty.value || fileDirty.value);
const mutationBusy = computed(() => overviewSaving.value || publishing.value || deletingDraft.value
  || deletingSkill.value || restoringDraft.value || fileSaving.value || fileDeleting.value || creatingDraft.value);
const bundleSize = computed(() => (activeDraft.value?.bundle_assets || []).reduce((total, asset) => total + (asset.size || 0), 0));
const publishedFileCount = computed(() => (selectedSkill.value?.files || []).filter((file) => file.type === 'file').length);
const canCreateDraft = computed(() => /^[a-z0-9][a-z0-9-]{0,63}$/.test(createDraftDialog.value.name)
  && createDraftDialog.value.description.trim().length > 0);
const canCreateFile = computed(() => isValidRelativePath(createFileDialog.value.path) && createFileDialog.value.content.length > 0);
const editableSelectedFile = computed(() => isEditableTextFile(selectedFile.value));

const filteredDrafts = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return skillDrafts.value;
  return skillDrafts.value.filter((draft) => `${draft.name} ${draft.description}`.toLowerCase().includes(query));
});

const filteredSkills = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return skills.value;
  return skills.value.filter((skill) => `${skill.name} ${skill.display_name || ''} ${skill.description || ''}`.toLowerCase().includes(query));
});

const filteredSkillGroups = computed(() => [
  { key: 'user_global', label: '租户发布包', items: filteredSkills.value.filter((skill) => skill.source_type === 'user_global') },
  { key: 'workspace', label: '工作区', items: filteredSkills.value.filter((skill) => skill.source_type === 'workspace') },
  { key: 'builtin', label: '内置', items: filteredSkills.value.filter((skill) => skill.source_type === 'builtin') },
].filter((group) => group.items.length));

const draftFileTree = computed(() => flattenFileTree(
  (activeDraft.value?.bundle_assets || []).map((asset) => ({ path: asset.relative_path, type: 'file', size: asset.size })),
  collapsedDirectories.value,
));
const publishedFileTree = computed(() => flattenFileTree(
  selectedSkill.value?.files || [],
  publishedCollapsedDirectories.value,
));

onMounted(() => refreshAll({ selectDefault: true }));

async function refreshAll({ selectDefault = false } = {}) {
  loadingAll.value = true;
  skillsLoading.value = true;
  draftsLoading.value = true;
  skillsError.value = '';
  draftsError.value = '';
  const [draftResult, skillResult] = await Promise.allSettled([listSkillDrafts(), listSkills()]);
  if (draftResult.status === 'fulfilled') skillDrafts.value = draftResult.value;
  else draftsError.value = draftResult.reason?.message || '加载 Skill Draft 失败';
  if (skillResult.status === 'fulfilled') skills.value = skillResult.value.data || [];
  else skillsError.value = skillResult.reason?.message || '加载 Skill 库失败';
  draftsLoading.value = false;
  skillsLoading.value = false;
  loadingAll.value = false;

  if (selectDefault && !activeKey.value) {
    if (skillDrafts.value.length) await selectDraft(skillDrafts.value[0], { skipGuard: true });
    else if (skills.value.length) {
      navigatorTab.value = 'library';
      await selectSkill(skills.value[0], { skipGuard: true });
    }
    return;
  }
  if (activeKind.value === 'draft') {
    const latest = skillDrafts.value.find((draft) => draft.id === activeKey.value);
    if (latest) await selectDraft(latest, { skipGuard: true });
  } else if (activeKind.value === 'skill') {
    const latest = skills.value.find((skill) => skill.name === activeKey.value);
    if (latest) await selectSkill(latest, { skipGuard: true });
  }
}

async function handleRefresh() {
  if (!await allowDiscardChanges()) return;
  await refreshAll();
}

async function changeNavigatorTab(value) {
  if (value === navigatorTab.value) return;
  if (!await allowDiscardChanges()) return;
  navigatorTab.value = value;
  searchQuery.value = '';
  if (value === 'drafts' && skillDrafts.value.length) await selectDraft(skillDrafts.value[0], { skipGuard: true });
  if (value === 'library' && skills.value.length) await selectSkill(skills.value[0], { skipGuard: true });
}

async function selectDraft(draft, { skipGuard = false } = {}) {
  if (!skipGuard && activeKind.value === 'draft' && activeKey.value === draft.id) return;
  if (!skipGuard && !await allowDiscardChanges()) return;
  navigatorTab.value = 'drafts';
  activeKind.value = 'draft';
  activeKey.value = draft.id;
  selectedSkill.value = null;
  overviewMode.value = 'edit';
  workspaceLoading.value = true;
  workspaceError.value = '';
  resetFileEditor();
  try {
    const loaded = await getSkillDraft(draft.id);
    applyDraft(loaded);
    if (workspaceTab.value === 'files') await selectDraftFile('SKILL.md', { skipGuard: true });
  } catch (error) {
    activeDraft.value = null;
    workspaceError.value = error?.message || '加载 Skill Draft 失败';
  } finally {
    workspaceLoading.value = false;
  }
}

async function selectSkill(skill, { skipGuard = false } = {}) {
  if (!skipGuard && activeKind.value === 'skill' && activeKey.value === skill.name) return;
  if (!skipGuard && !await allowDiscardChanges()) return;
  navigatorTab.value = 'library';
  activeKind.value = 'skill';
  activeKey.value = skill.name;
  activeDraft.value = null;
  publishedTab.value = 'overview';
  publishedCollapsedDirectories.value = new Set();
  workspaceLoading.value = true;
  workspaceError.value = '';
  resetFileEditor();
  try {
    const response = await getSkillDetail(skill.name);
    selectedSkill.value = response.data;
  } catch (error) {
    selectedSkill.value = null;
    workspaceError.value = error?.message || '加载 Skill 详情失败';
  } finally {
    workspaceLoading.value = false;
  }
}

function applyDraft(draft) {
  activeDraft.value = draft;
  activeKind.value = 'draft';
  activeKey.value = draft.id;
  draftForm.value = { name: draft.name, description: draft.description, content: draft.content };
  const index = skillDrafts.value.findIndex((item) => item.id === draft.id);
  if (index >= 0) skillDrafts.value.splice(index, 1, draft);
  else skillDrafts.value.unshift(draft);
}

async function changeWorkspaceTab(value) {
  if (value === workspaceTab.value) return;
  if (!await allowDiscardChanges()) return;
  workspaceTab.value = value;
  workspaceError.value = '';
  if (value === 'files' && activeDraft.value) await selectDraftFile('SKILL.md', { skipGuard: true });
}

async function saveOverview() {
  if (!activeDraft.value || !overviewDirty.value || !canEditSkillDraft.value) return;
  overviewSaving.value = true;
  workspaceError.value = '';
  const current = activeDraft.value;
  try {
    const updated = await updateSkillDraft(current.id, current.revision, draftForm.value);
    applyDraft(updated);
    await syncPublishedState(updated);
    toast.success(updated.status === 'published' ? 'Skill 已保存并自动发布' : 'Skill Draft 已保存');
  } catch (error) {
    workspaceError.value = error?.message || '保存 Skill Draft 失败';
    if (error?.status === 409) await recoverDraft(current.id);
  } finally {
    overviewSaving.value = false;
  }
}

async function publishDraft() {
  if (!activeDraft.value || hasUnsavedChanges.value || !canEditSkillDraft.value) return;
  const current = activeDraft.value;
  const accepted = await confirm({
    title: '发布 Skill Draft',
    message: `确认发布“${current.name}”？发布前会自动校验完整 bundle。`,
    confirmText: current.published_at ? '重新发布' : '发布',
    danger: false,
  });
  if (!accepted) return;
  publishing.value = true;
  workspaceError.value = '';
  try {
    const updated = await publishSkillDraft(current.id, current.revision);
    applyDraft(updated);
    await syncPublishedState(updated);
    toast.success('Skill 已发布');
  } catch (error) {
    workspaceError.value = error?.message || '发布 Skill 失败';
    if (error?.status === 409) await recoverDraft(current.id);
  } finally {
    publishing.value = false;
  }
}

async function deleteDraft() {
  if (!activeDraft.value || !canEditSkillDraft.value) return;
  const current = activeDraft.value;
  const accepted = await confirm({
    title: '删除 Skill Draft',
    message: current.status === 'published'
      ? `删除“${current.name}”的 Draft？已发布 Skill 不受影响，之后仍可从发布包恢复。`
      : `删除“${current.name}”的 Draft？此操作不可恢复。`,
    confirmText: '删除 Draft',
    danger: true,
  });
  if (!accepted) return;
  deletingDraft.value = true;
  workspaceError.value = '';
  try {
    await deleteSkillDraft(current.id);
    skillDrafts.value = skillDrafts.value.filter((draft) => draft.id !== current.id);
    activeDraft.value = null;
    activeKey.value = '';
    resetFileEditor();
    toast.success('Skill Draft 已删除');
    if (skillDrafts.value.length) await selectDraft(skillDrafts.value[0], { skipGuard: true });
    else if (skills.value.length) {
      navigatorTab.value = 'library';
      await selectSkill(skills.value[0], { skipGuard: true });
    }
  } catch (error) {
    workspaceError.value = error?.message || '删除 Skill Draft 失败';
  } finally {
    deletingDraft.value = false;
  }
}

async function editPublishedSkill() {
  if (!selectedSkill.value || !canEditSkillDraft.value) return;
  restoringDraft.value = true;
  workspaceError.value = '';
  try {
    const draft = await ensureSkillDraft(selectedSkill.value.name);
    applyDraft(draft);
    navigatorTab.value = 'drafts';
    workspaceTab.value = 'overview';
    selectedSkill.value = null;
    toast.success('已打开可编辑 Draft');
  } catch (error) {
    workspaceError.value = error?.message || '准备 Skill Draft 失败';
  } finally {
    restoringDraft.value = false;
  }
}

async function deletePublishedSkill() {
  if (!selectedSkill.value || !canEditSkillDraft.value) return;
  const current = selectedSkill.value;
  const accepted = await confirm({
    title: '删除已发布 Skill',
    message: `确认删除“${current.name}”？已有 Draft 会恢复为未发布状态。`,
    confirmText: '删除 Skill',
    danger: true,
  });
  if (!accepted) return;
  deletingSkill.value = true;
  workspaceError.value = '';
  try {
    await deleteSkill(current.name);
    selectedSkill.value = null;
    activeKey.value = '';
    await refreshAll();
    toast.success('已发布 Skill 已删除');
  } catch (error) {
    workspaceError.value = error?.message || '删除 Skill 失败';
  } finally {
    deletingSkill.value = false;
  }
}

async function selectDraftFile(relativePath, { skipGuard = false } = {}) {
  if (!activeDraft.value) return;
  if (!skipGuard && selectedFilePath.value === relativePath) return;
  if (!skipGuard && fileDirty.value && !await allowDiscardChanges()) return;
  selectedFilePath.value = relativePath;
  selectedFile.value = null;
  fileLoading.value = true;
  workspaceError.value = '';
  try {
    const file = await getSkillDraftFile(activeDraft.value.id, relativePath);
    selectedFile.value = file;
    if (isEditableTextFile(file)) {
      fileText.value = decodeBase64Text(file.body_base64);
      originalFileText.value = fileText.value;
    } else {
      fileText.value = '';
      originalFileText.value = '';
    }
  } catch (error) {
    selectedFilePath.value = '';
    workspaceError.value = error?.message || '读取 Draft 文件失败';
  } finally {
    fileLoading.value = false;
  }
}

async function saveSelectedFile() {
  if (!activeDraft.value || !selectedFile.value || !fileDirty.value || !canEditSkillDraft.value) return;
  const current = activeDraft.value;
  fileSaving.value = true;
  workspaceError.value = '';
  try {
    const updated = await putSkillDraftFile(current.id, current.revision, {
      relative_path: selectedFile.value.relative_path,
      media_type: selectedFile.value.media_type,
      body_base64: encodeBase64Text(fileText.value),
    });
    applyDraft(updated);
    originalFileText.value = fileText.value;
    selectedFile.value = {
      ...selectedFile.value,
      ...updated.bundle_assets.find((asset) => asset.relative_path === selectedFilePath.value),
      body_base64: encodeBase64Text(fileText.value),
    };
    await syncPublishedState(updated);
    toast.success(updated.status === 'published' ? '文件已保存并自动发布' : 'Draft 文件已保存');
  } catch (error) {
    workspaceError.value = error?.message || '保存 Draft 文件失败';
    if (error?.status === 409) await recoverDraft(current.id);
  } finally {
    fileSaving.value = false;
  }
}

async function deleteSelectedFile() {
  if (!activeDraft.value || !selectedFile.value || selectedFile.value.relative_path === 'SKILL.md') return;
  const current = activeDraft.value;
  const relativePath = selectedFile.value.relative_path;
  const accepted = await confirm({
    title: '删除 bundle 文件',
    message: `确认从 Draft 删除“${relativePath}”？`,
    confirmText: '删除文件',
    danger: true,
  });
  if (!accepted) return;
  fileDeleting.value = true;
  workspaceError.value = '';
  try {
    const updated = await deleteSkillDraftFile(current.id, current.revision, relativePath);
    applyDraft(updated);
    resetFileEditor();
    await selectDraftFile('SKILL.md', { skipGuard: true });
    await syncPublishedState(updated);
    toast.success(updated.status === 'published' ? '文件已删除并自动发布' : 'Draft 文件已删除');
  } catch (error) {
    workspaceError.value = error?.message || '删除 Draft 文件失败';
    if (error?.status === 409) await recoverDraft(current.id);
  } finally {
    fileDeleting.value = false;
  }
}

function openFilePicker() {
  if (!activeDraft.value || mutationBusy.value) return;
  fileInput.value?.click();
}

async function uploadSelectedFile(event) {
  const input = event.target;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !activeDraft.value) return;
  const relativePath = file.webkitRelativePath || file.name;
  if (!isValidRelativePath(relativePath)) {
    workspaceError.value = '文件路径无效';
    return;
  }
  const existing = activeDraft.value.bundle_assets.some((asset) => asset.relative_path.toLowerCase() === relativePath.toLowerCase());
  if (existing) {
    const accepted = await confirm({
      title: '替换 bundle 文件',
      message: `“${relativePath}”已存在，确认使用上传文件替换？`,
      confirmText: '替换',
      danger: false,
    });
    if (!accepted) return;
  }
  const current = activeDraft.value;
  fileSaving.value = true;
  workspaceError.value = '';
  try {
    const updated = await putSkillDraftFile(current.id, current.revision, {
      relative_path: relativePath,
      media_type: file.type || guessMediaType(relativePath),
      body_base64: await readFileAsBase64(file),
    });
    applyDraft(updated);
    await selectDraftFile(relativePath, { skipGuard: true });
    await syncPublishedState(updated);
    toast.success(updated.status === 'published' ? '文件已上传并自动发布' : '文件已加入 Draft');
  } catch (error) {
    workspaceError.value = error?.message || '上传 Draft 文件失败';
    if (error?.status === 409) await recoverDraft(current.id);
  } finally {
    fileSaving.value = false;
  }
}

function openCreateFile() {
  createFileDialog.value = { open: true, path: '', content: '', error: '' };
}

function closeCreateFile() {
  if (fileSaving.value) return;
  createFileDialog.value.open = false;
  createFileDialog.value.error = '';
}

async function createTextFile() {
  if (!activeDraft.value || !canCreateFile.value) return;
  const current = activeDraft.value;
  const relativePath = createFileDialog.value.path.replaceAll('\\', '/');
  if (current.bundle_assets.some((asset) => asset.relative_path.toLowerCase() === relativePath.toLowerCase())) {
    createFileDialog.value.error = '同名文件已存在，请在文件树中打开后编辑。';
    return;
  }
  fileSaving.value = true;
  createFileDialog.value.error = '';
  try {
    const updated = await putSkillDraftFile(current.id, current.revision, {
      relative_path: relativePath,
      media_type: guessMediaType(relativePath),
      body_base64: encodeBase64Text(createFileDialog.value.content),
    });
    applyDraft(updated);
    createFileDialog.value.open = false;
    await selectDraftFile(relativePath, { skipGuard: true });
    await syncPublishedState(updated);
    toast.success(updated.status === 'published' ? '文件已创建并自动发布' : '文本文件已创建');
  } catch (error) {
    createFileDialog.value.error = error?.message || '创建 Draft 文件失败';
    if (error?.status === 409) await recoverDraft(current.id);
  } finally {
    fileSaving.value = false;
  }
}

function downloadDraftFile() {
  if (!selectedFile.value?.body_base64) return;
  const bytes = decodeBase64Bytes(selectedFile.value.body_base64);
  const blob = new Blob([bytes], { type: selectedFile.value.media_type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = selectedFile.value.relative_path.split('/').pop() || 'skill-file';
  link.click();
  URL.revokeObjectURL(url);
}

function openCreateDraft() {
  createDraftDialog.value = { open: true, name: '', description: '', error: '' };
}

function closeCreateDraft() {
  if (creatingDraft.value) return;
  createDraftDialog.value.open = false;
  createDraftDialog.value.error = '';
}

async function createDraft() {
  if (!canCreateDraft.value) return;
  creatingDraft.value = true;
  createDraftDialog.value.error = '';
  try {
    const draft = await createSkillDraft(createDraftDialog.value.name, createDraftDialog.value.description);
    createDraftDialog.value.open = false;
    applyDraft(draft);
    navigatorTab.value = 'drafts';
    workspaceTab.value = 'overview';
    selectedSkill.value = null;
    toast.success('Skill Draft 已创建');
  } catch (error) {
    createDraftDialog.value.error = error?.message || '创建 Skill Draft 失败';
  } finally {
    creatingDraft.value = false;
  }
}

async function allowDiscardChanges() {
  if (!hasUnsavedChanges.value) return true;
  return confirm({
    title: '放弃未保存更改',
    message: '当前编辑内容尚未保存，继续操作会丢失这些更改。',
    confirmText: '放弃更改',
    danger: true,
  });
}

async function recoverDraft(id) {
  try {
    applyDraft(await getSkillDraft(id));
    resetFileEditor();
  } catch {
    // Preserve the original mutation error when recovery is unavailable.
  }
}

async function syncPublishedState(draft) {
  if (draft.status !== 'published') return;
  try {
    const response = await listSkills();
    skills.value = response.data || [];
  } catch (error) {
    skillsError.value = error?.message || 'Skill 已更新，但刷新 Skill 库失败';
    toast.warning(skillsError.value);
  }
}

function resetFileEditor() {
  selectedFilePath.value = '';
  selectedFile.value = null;
  fileText.value = '';
  originalFileText.value = '';
}

function toggleDirectory(path) {
  const next = new Set(collapsedDirectories.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsedDirectories.value = next;
}

function togglePublishedDirectory(path) {
  const next = new Set(publishedCollapsedDirectories.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  publishedCollapsedDirectories.value = next;
}

function flattenFileTree(files, collapsed) {
  const root = { children: [] };
  for (const file of files || []) {
    const path = String(file.path || '').replaceAll('\\', '/');
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) continue;
    let parent = root;
    parts.forEach((part, index) => {
      const nodePath = parts.slice(0, index + 1).join('/');
      const last = index === parts.length - 1;
      let node = parent.children.find((child) => child.name === part);
      if (!node) {
        node = {
          name: part,
          path: nodePath,
          type: last ? (file.type || 'file') : 'directory',
          size: last ? file.size : undefined,
          children: [],
        };
        parent.children.push(node);
      }
      parent = node;
    });
  }
  const sort = (nodes) => {
    nodes.sort((left, right) => left.type === right.type
      ? left.name.localeCompare(right.name)
      : left.type === 'directory' ? -1 : 1);
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  const flattened = [];
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      const isCollapsed = node.type === 'directory' && collapsed.has(node.path);
      flattened.push({ ...node, depth, collapsed: isCollapsed });
      if (node.type === 'directory' && !isCollapsed) walk(node.children, depth + 1);
    }
  };
  walk(root.children, 0);
  return flattened;
}

function draftStatusLabel(draft) {
  if (draft.status === 'published' && draft.package_state === 'missing') return '发布包缺失';
  if (draft.status === 'published' && draft.package_state === 'conflict') return '发布冲突';
  return draft.status === 'published' ? '已发布' : '待发布';
}

function draftStatusVariant(draft) {
  if (draft.status === 'published' && ['conflict', 'missing'].includes(draft.package_state)) return 'destructive';
  return draft.status === 'published' ? 'success' : 'warning';
}

function draftOrigin(draft) {
  if (draft.source_agent_name) return `由 ${draft.source_agent_name} 创建`;
  if (draft.source_session_id) return `来自会话 ${draft.source_session_id}`;
  return '管理员 Draft';
}

function sourceLabel(sourceType) {
  return { user_global: '租户', workspace: '工作区', builtin: '内置' }[sourceType] || '系统';
}

function formatDraftDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatCompactDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatSize(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isEditableTextFile(file) {
  if (!file || file.size > 2 * 1024 * 1024) return false;
  return file.media_type?.startsWith('text/')
    || /(?:json|javascript|typescript|yaml|xml|sql)/i.test(file.media_type || '')
    || /\.(?:md|txt|py|js|ts|tsx|jsx|json|ya?ml|csv|sh|ps1|sql|css|html|vue|toml|ini|cfg)$/i.test(file.relative_path || '');
}

function isValidRelativePath(value) {
  const normalized = String(value || '').trim().replaceAll('\\', '/');
  return Boolean(normalized)
    && !normalized.startsWith('/')
    && !/^[A-Za-z]:/.test(normalized)
    && normalized.split('/').every((part) => part && part !== '.' && part !== '..');
}

function guessMediaType(path) {
  const extension = path.split('.').pop()?.toLowerCase();
  return {
    md: 'text/markdown; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    py: 'text/x-python; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    ts: 'text/typescript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    yaml: 'text/yaml; charset=utf-8',
    yml: 'text/yaml; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
  }[extension] || 'text/plain; charset=utf-8';
}

function encodeBase64Text(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64Bytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeBase64Text(value) {
  return new TextDecoder().decode(decodeBase64Bytes(value));
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function onMdNotify({ message, type }) {
  if (type === 'success') toast.success(message);
  else toast.error(message);
}
</script>

<style scoped>
.skill-workbench {
  display: grid;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  align-items: start;
  gap: var(--spacing-lg);
}

.skill-list-card {
  position: sticky;
  top: var(--spacing-md);
  min-width: 0;
  overflow: hidden;
}

.skill-workspace-card {
  min-width: 0;
  min-height: 560px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-secondary);
}

.skill-workspace,
.bundle-tree,
.file-editor,
.published-content {
  min-width: 0;
  min-height: 0;
}

.skill-navigator__head {
  flex-direction: column;
  gap: var(--spacing-sm);
  border-bottom: 1px solid var(--color-border);
}

.navigator-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.skill-navigator__tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  width: 100%;
}

.skill-navigator__tabs :deep([data-state='active']) {
  background: var(--color-bg-tertiary);
  box-shadow: none;
  color: var(--color-text-primary);
}

.skill-navigator__search {
  height: 34px;
}

.skill-navigator__body {
  max-height: calc(100vh - 212px);
  overflow-y: auto;
  padding: var(--spacing-md) !important;
}

.navigator-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-primary);
  text-align: left;
  cursor: pointer;
}

.navigator-row:hover {
  background: var(--color-hover-overlay-md);
}

.navigator-row--active {
  border-color: var(--color-brand-accent);
  background: var(--color-active-bg);
}

.navigator-row__title,
.navigator-row__meta,
.navigator-group__label,
.workspace-header__title-row,
.workspace-header__actions,
.file-editor__toolbar,
.file-editor__actions,
.pane-heading,
.pane-heading__actions,
.field-heading {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.navigator-row__title,
.navigator-row__meta,
.navigator-group__label,
.file-editor__toolbar,
.pane-heading,
.field-heading {
  justify-content: space-between;
}

.navigator-row__name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.navigator-row p {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.navigator-row__meta {
  color: var(--color-text-muted);
  font-size: 11px;
}

.navigator-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: var(--spacing-md);
}

.navigator-group__label {
  padding: 9px 10px 5px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.navigator-state,
.workspace-state,
.binary-file-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: var(--spacing-sm);
  min-height: 180px;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
}

.navigator-state--error,
.workspace-state--error {
  color: var(--color-error);
}

.navigator-empty {
  min-height: 260px;
}

.skill-workspace {
  display: flex;
  flex-direction: column;
  min-height: 560px;
}

.workspace-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-lg);
  min-height: 96px;
  padding: var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
}

.workspace-header__identity {
  min-width: 0;
}

.workspace-header__title-row {
  flex-wrap: wrap;
}

.workspace-header h2 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-lg);
  font-weight: 650;
}

.workspace-header p {
  margin: 5px 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
}

.workspace-header__identity > span {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.workspace-header__actions {
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.workspace-message {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 9px var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-error);
  font-size: var(--font-size-xs);
}

.workspace-message svg {
  width: 15px;
  flex-shrink: 0;
}

.workspace-tabbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-lg) 0;
}

.workspace-tabs,
.overview-mode-tabs {
  min-width: 0;
}

.workspace-tabs :deep([data-state='active']),
.overview-mode-tabs :deep([data-state='active']),
.published-tabs :deep([data-state='active']) {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  box-shadow: none;
}

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
  border-radius: var(--radius-sm);
  background: transparent;
}

.overview-textarea {
  min-height: 310px;
  resize: vertical;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  line-height: 1.65;
}

.field-heading > span {
  color: var(--color-text-muted);
  font-size: 11px;
}

.pane-heading {
  min-height: 44px;
  padding: 0 var(--spacing-md);
  border-bottom: 1px solid var(--color-border);
}

.pane-heading > div:first-child,
.file-editor__identity {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.pane-heading strong,
.file-editor__identity strong {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
}

.pane-heading span,
.file-editor__identity span {
  color: var(--color-text-muted);
  font-size: 11px;
}

.pane-heading > svg {
  width: 16px;
  color: var(--color-text-muted);
}

.overview-preview__body,
.published-content__body {
  flex: 1;
  min-height: 0;
  padding: var(--spacing-md);
  overflow-y: auto;
}

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

.published-tabs {
  padding: var(--spacing-md) var(--spacing-lg) 0;
}

.published-tabs__count {
  color: var(--color-text-muted);
  font-size: 11px;
}

.bundle-tree {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: transparent;
}

.file-tree-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--spacing-xs);
}

.file-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 30px;
  padding-top: 4px;
  padding-right: 8px;
  padding-bottom: 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  text-align: left;
}

button.file-row {
  cursor: pointer;
}

button.file-row:hover,
.file-row--active {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.file-row--active {
  box-shadow: inset 2px 0 0 var(--color-brand-accent);
}

.file-row svg {
  width: 14px;
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.file-row__chevron {
  transition: transform var(--transition-fast);
}

.file-row__chevron--closed {
  transform: rotate(-90deg);
}

.file-row span,
.file-row a {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-row a:hover {
  text-decoration: underline;
}

.file-row small {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: 10px;
}

.file-editor {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.file-editor__toolbar {
  min-height: 58px;
  padding: var(--spacing-sm) var(--spacing-md);
  border-bottom: 1px solid var(--color-border);
}

.file-editor__identity strong,
.file-editor__identity span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.published-content {
  display: flex;
  min-height: 520px;
  flex-direction: column;
  overflow: hidden;
}

.published-files {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  margin: 0 var(--spacing-lg) var(--spacing-lg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

.published-file-tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--spacing-xs);
}

.published-file-row:hover {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.published-file-row:focus-visible {
  outline: 2px solid var(--color-brand-accent);
  outline-offset: -2px;
}

.new-file-textarea {
  min-height: 180px;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

.dialog-error {
  margin: 0;
  color: var(--color-error);
  font-size: var(--font-size-xs);
}

@media (max-width: 960px) {
  .skill-workbench {
    grid-template-columns: 1fr;
    height: auto;
    min-height: 0;
    overflow: visible;
  }

  .skill-list-card {
    position: static;
    max-height: 340px;
    border-right: none;
    border-bottom: 1px solid var(--color-border);
  }

  .skill-workspace {
    min-height: 620px;
  }

  .workspace-header {
    flex-direction: column;
  }

  .workspace-header__actions {
    justify-content: flex-start;
  }

  .workspace-tabbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .bundle-pane {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }

  .bundle-tree {
    max-height: 280px;
    border-right: none;
    border-bottom: 1px solid var(--color-border);
  }

  .file-editor,
  .published-content,
  .published-files {
    min-height: 420px;
  }

}
</style>
