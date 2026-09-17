import { computed, ref } from 'vue';
import { useAuthStore } from '../../stores/auth.js';
import { flattenFileTree } from '../../utils/fileTree.js';
import { base64EncodedSize, decodeBase64Text, encodeBase64Text } from '../../utils/base64.js';
import { isEditableTextFile, isValidRelativePath } from '../../utils/skillFiles.js';

/**
 * 脏检查基线：只留参与比较的字段。未编辑文件与基线共享同一字符串引用，
 * 逐项比较退化为 O(1) 引用比对，避免每次按键全量 JSON.stringify 整个 bundle。
 */
export function filesBaseline(files) {
  return files.map((file) => ({ relative_path: file.relative_path, media_type: file.media_type ?? '', body_base64: file.body_base64 }));
}

export function createSkillLibraryState() {
  const auth = useAuthStore();
  const canManage = computed(() => auth.hasTenantRole('admin'));
  const skills = ref([]);
  const loading = ref(false);
  const busy = ref(false);
  const error = ref('');
  const listError = ref('');
  const searchQuery = ref('');
  const activeSkill = ref(null);
  const originalFiles = ref([]);
  const selectedFilePath = ref('SKILL.md');
  const fileTreeOpen = ref(true);
  const collapsedDirectories = ref(new Set());
  const editorMode = ref('edit');
  const createDialog = ref({ open: false, name: '', description: '' });
  const createFileDialog = ref({ open: false, path: '', content: '', error: '' });
  const canEdit = computed(() => canManage.value && activeSkill.value?.writable === true);
  const selectedFile = computed(() => activeSkill.value?.files.find((file) => file.relative_path === selectedFilePath.value) ?? null);
  const fileText = computed({
    get: () => selectedFile.value ? decodeBase64Text(selectedFile.value.body_base64) : '',
    set: (value) => { if (canEdit.value && !loading.value && !busy.value && selectedFile.value) selectedFile.value.body_base64 = encodeBase64Text(value); },
  });
  const editableSelectedFile = computed(() => selectedFile.value && isEditableTextFile({ ...selectedFile.value, size: base64EncodedSize(selectedFile.value.body_base64) }));
  const baselineByPath = computed(() => new Map(originalFiles.value.map(file => [file.relative_path, file])));
  const fileChanges = computed(() => {
    if (!activeSkill.value?.writable) return new Map();
    const baseline = activeSkill.value.revision ? baselineByPath.value : new Map();
    const changes = new Map([...baseline.keys()].map(path => [path, 'deleted']));
    for (const file of activeSkill.value.files) {
      const original = baseline.get(file.relative_path);
      if (!original) changes.set(file.relative_path, 'added');
      else if ((file.media_type ?? '') !== original.media_type || file.body_base64 !== original.body_base64) changes.set(file.relative_path, 'modified');
      else changes.delete(file.relative_path);
    }
    return changes;
  });
  const hasUnsavedChanges = computed(() => Boolean(activeSkill.value?.writable) && (!activeSkill.value.revision || fileChanges.value.size > 0));
  const fileTree = computed(() => {
    const changedDirectories = new Set();
    for (const path of fileChanges.value.keys()) {
      const parts = path.split('/');
      while (parts.length > 1) { parts.pop(); changedDirectories.add(parts.join('/')); }
    }
    return flattenFileTree((activeSkill.value?.files ?? []).map((file) => ({ path: file.relative_path, type: 'file', size: base64EncodedSize(file.body_base64) })), collapsedDirectories.value)
      .map(node => ({ ...node, change: node.type === 'directory' ? (changedDirectories.has(node.path) ? 'modified' : undefined) : fileChanges.value.get(node.path) }));
  });
  const filteredSkillGroups = computed(() => {
    const query = searchQuery.value.trim().toLowerCase();
    const filtered = skills.value.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query));
    return [['user_global', '租户'], ['builtin', '内置'], ['workspace', '工作区']]
      .map(([key, label]) => ({ key, label, items: filtered.filter((skill) => skill.source_type === key) })).filter((group) => group.items.length);
  });
  const canCreate = computed(() => /^[a-z0-9][a-z0-9-]{0,63}$/.test(createDialog.value.name) && createDialog.value.description.trim());
  const canCreateFile = computed(() => isValidRelativePath(createFileDialog.value.path));
  return { canManage, canEdit, skills, loading, busy, error, listError, searchQuery, activeSkill, originalFiles,
    selectedFilePath, selectedFile, fileTreeOpen, collapsedDirectories, editorMode, createDialog, createFileDialog,
    fileText, editableSelectedFile, hasUnsavedChanges, fileChanges, fileTree, filteredSkillGroups, canCreate, canCreateFile };
}
