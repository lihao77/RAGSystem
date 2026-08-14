/**
 * Skill 库页面的共享响应式状态 + 纯派生 computed（无副作用）。
 * 动作逻辑分散在 useSkillLibrary / useSkillDraftActions / useSkillDraftFiles，
 * 三者通过本模块产出的 state 对象协作。
 */

import { computed, ref } from 'vue';

import { useAuthStore } from '../../stores/auth.js';
import { flattenFileTree } from '../../utils/fileTree.js';
import { isEditableTextFile, isValidRelativePath } from '../../utils/skillFiles.js';

export function createSkillLibraryState() {
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
  const publishedTab = ref('overview');
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
  const collapsedDirectories = ref(new Set());
  const publishedCollapsedDirectories = ref(new Set());
  const createDraftDialog = ref({ open: false, name: '', description: '', error: '' });
  const createFileDialog = ref({ open: false, path: '', content: '', error: '' });

  const navigatorLoading = computed(() => navigatorTab.value === 'drafts' ? draftsLoading.value : skillsLoading.value);
  const navigatorError = computed(() => navigatorTab.value === 'drafts' ? draftsError.value : skillsError.value);
  const draftNameLocked = computed(() => Boolean(activeDraft.value?.published_at));
  const overviewDirty = computed(() => Boolean(activeDraft.value) && (
    draftForm.value.name !== activeDraft.value.name
    || draftForm.value.description !== activeDraft.value.description
    || draftForm.value.content !== activeDraft.value.content
  ));
  const editableSelectedFile = computed(() => isEditableTextFile(selectedFile.value));
  const fileDirty = computed(() => editableSelectedFile.value && fileText.value !== originalFileText.value);
  const hasUnsavedChanges = computed(() => overviewDirty.value || fileDirty.value);
  const mutationBusy = computed(() => overviewSaving.value || publishing.value || deletingDraft.value
    || deletingSkill.value || restoringDraft.value || fileSaving.value || fileDeleting.value || creatingDraft.value);
  const bundleSize = computed(() => (activeDraft.value?.bundle_assets || []).reduce((total, asset) => total + (asset.size || 0), 0));
  const publishedFileCount = computed(() => (selectedSkill.value?.files || []).filter((file) => file.type === 'file').length);
  const canCreateDraft = computed(() => /^[a-z0-9][a-z0-9-]{0,63}$/.test(createDraftDialog.value.name)
    && createDraftDialog.value.description.trim().length > 0);
  const canCreateFile = computed(() => isValidRelativePath(createFileDialog.value.path) && createFileDialog.value.content.length > 0);

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

  return {
    canEditSkillDraft,
    skills, skillDrafts, loadingAll, skillsLoading, draftsLoading, skillsError, draftsError,
    navigatorTab, searchQuery, activeKind, activeKey, activeDraft, selectedSkill,
    workspaceLoading, workspaceError, workspaceTab, overviewMode, publishedTab,
    draftForm, overviewSaving, publishing, deletingDraft, deletingSkill, restoringDraft, creatingDraft,
    fileLoading, fileSaving, fileDeleting, selectedFilePath, selectedFile, fileText, originalFileText,
    collapsedDirectories, publishedCollapsedDirectories, createDraftDialog, createFileDialog,
    navigatorLoading, navigatorError, draftNameLocked, overviewDirty, editableSelectedFile, fileDirty,
    hasUnsavedChanges, mutationBusy, bundleSize, publishedFileCount, canCreateDraft, canCreateFile,
    filteredDrafts, filteredSkills, filteredSkillGroups, draftFileTree, publishedFileTree,
  };
}
