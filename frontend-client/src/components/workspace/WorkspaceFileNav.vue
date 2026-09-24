<template>
  <section class="workspace-file-nav" aria-label="项目文件浏览">
    <div class="workspace-file-nav__toolbar">
      <Button
        variant="ghost"
        size="icon-xs"
        title="返回会话列表"
        aria-label="返回会话列表"
        @click="emit('exit')"
      >
        <ArrowLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        title="刷新"
        aria-label="刷新文件列表"
        :disabled="!selectedWorkspaceId"
        @click="refresh"
      >
        <RefreshCw :class="{ 'animate-spin': rootLoading }" />
      </Button>
    </div>

    <div v-if="workspaceItems.length" class="workspace-file-nav__picker">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="workspace-file-nav__picker-trigger"
            :title="selectedWorkspace?.root_path || selectedWorkspace?.display_name || '选择项目'"
          >
            <FolderTree aria-hidden="true" />
            <span class="workspace-file-nav__picker-name">{{ selectedWorkspace?.display_name || '选择项目' }}</span>
            <ChevronsUpDown aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="w-56">
          <DropdownMenuItem
            v-for="workspace in workspaceItems"
            :key="workspace.workspace_id"
            :title="workspace.root_path || workspace.display_name"
            @select="selectWorkspace(workspace.workspace_id)"
          >
            <Folder aria-hidden="true" />
            <span class="max-w-0 flex-1 truncate">{{ workspace.display_name }}</span>
            <Check v-if="workspace.workspace_id === selectedWorkspaceId" aria-hidden="true" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div class="workspace-file-nav__body">
      <!-- 无项目：引导回项目视图添加 -->
      <div v-if="!workspaceItems.length" class="workspace-file-nav__hint">
        <FolderTree aria-hidden="true" />
        <p>还没有本地项目。</p>
        <p>返回会话列表，在「项目」视图添加一个本地项目后即可浏览其文件。</p>
      </div>

      <div v-else-if="rootLoading && !nodes.length" class="flex flex-col gap-2 p-2">
        <div v-for="index in 8" :key="index" class="flex items-center gap-2 px-1">
          <Skeleton class="h-3.5 w-4/5" :style="{ maxWidth: `${60 + ((index * 13) % 35)}%` }" />
        </div>
      </div>

      <div v-else-if="rootError && !nodes.length" class="workspace-file-nav__hint is-error">
        <p>{{ rootError }}</p>
        <Button variant="outline" size="sm" @click="loadRoot">重试</Button>
      </div>

      <template v-else>
        <SkillFileTree
          :nodes="nodes"
          :selected-path="selectedPath"
          :icon-for="fileIconOf"
          sticky-dirs
          @select="onSelectFile"
          @toggle="onToggleDir"
        />
        <div v-if="hasTruncated" class="workspace-file-nav__truncated">目录条目过多，已截断显示</div>
      </template>
    </div>
  </section>
</template>

<script setup>
import { computed, inject, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { ArrowLeft, Check, ChevronsUpDown, Folder, FolderTree, RefreshCw } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import SkillFileTree from '@/components/skill-library/SkillFileTree.vue';
import { getFileIcon, getFileIconColor } from '@/components/files/categoryIcons.js';
import { categorizeFile } from '@/components/files/fileCategorize.js';
import { listWorkspaceEntries } from '@/api/workspaceFile.js';
import { useWorkspaceStore } from '@/stores/workspace.js';
import { useSessionRunStore } from '@/stores/session-run.js';
import { useToast } from '@/composables/useToast.js';

const ROOT_PATH = '.';

const props = defineProps({
  /** 入口指定的项目（项目分组头「浏览文件」带过来的目标项目）。 */
  workspaceId: { type: String, default: '' },
});
const emit = defineEmits(['update:workspace-id', 'exit']);

const toast = useToast();
const workspaceStore = useWorkspaceStore();
const sessionRunStore = useSessionRunStore();
const shellSidebarControl = inject('shellSidebarControl', null);
const { items: workspaceItems } = storeToRefs(workspaceStore);

// 选中项目：入口指定的优先，缺省回落当前项目/第一个项目；切换后整体重置树。
const selectedWorkspaceId = ref('');
const selectedWorkspace = computed(() => workspaceItems.value.find(
  (item) => item.workspace_id === selectedWorkspaceId.value,
) || null);

watch(() => props.workspaceId, (id) => {
  if (id && id !== selectedWorkspaceId.value) selectedWorkspaceId.value = id;
});

watch(
  () => [workspaceItems.value.map((item) => item.workspace_id).join('\u0000'), props.workspaceId],
  ([idsJoined]) => {
    const ids = String(idsJoined || '').split('\u0000').filter(Boolean);
    if (selectedWorkspaceId.value && ids.includes(selectedWorkspaceId.value)) return;
    const current = workspaceStore.currentWorkspaceId;
    selectedWorkspaceId.value = ids.includes(current) ? current : (ids[0] || '');
  },
  { immediate: true },
);

/** 每层目录一份状态：entries 为该目录直接子项（目录在前，服务端已排序）。 */
const dirs = ref({});
const expandedPaths = ref([]);
const selectedPath = ref('');

const rootDir = computed(() => dirs.value[ROOT_PATH] || null);
const rootLoading = computed(() => rootDir.value?.status === 'loading');
const rootError = computed(() => (rootDir.value?.status === 'error' ? rootDir.value.error : ''));
const hasTruncated = computed(() => Object.values(dirs.value).some((dir) => dir.status === 'loaded' && dir.truncated));

const nodes = computed(() => {
  const out = [];
  const walk = (dirPath, depth) => {
    const dir = dirs.value[dirPath];
    if (dir?.status !== 'loaded') return;
    for (const entry of dir.entries) {
      const isDirectory = entry.type === 'directory';
      out.push({
        type: entry.type,
        path: entry.path,
        name: entry.name,
        depth,
        collapsed: isDirectory ? !expandedPaths.value.includes(entry.path) : false,
        size: entry.size,
        iconColor: isDirectory ? null : getFileIconColor(categorizeFile(entry.path)),
      });
      if (isDirectory && expandedPaths.value.includes(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk(ROOT_PATH, 0);
  return out;
});

// 文件按类型出图标（纯文本 txt/log 走 FileText，其余按类别）
const fileIconOf = (node) => getFileIcon(categorizeFile(node.path));

async function loadDir(dirPath) {
  const workspaceId = selectedWorkspaceId.value;
  if (!workspaceId) return;
  dirs.value = { ...dirs.value, [dirPath]: { status: 'loading', entries: [], truncated: false, error: '' } };
  try {
    const data = await listWorkspaceEntries(workspaceId, dirPath === ROOT_PATH ? '' : dirPath);
    // 加载期间切换了项目：丢弃过期结果，避免把 A 项目的目录写进 B 项目的树
    if (workspaceId !== selectedWorkspaceId.value) return;
    dirs.value = {
      ...dirs.value,
      [dirPath]: { status: 'loaded', entries: Array.isArray(data.entries) ? data.entries : [], truncated: Boolean(data.truncated), error: '' },
    };
  } catch (cause) {
    if (workspaceId !== selectedWorkspaceId.value) return;
    dirs.value = { ...dirs.value, [dirPath]: { status: 'error', entries: [], truncated: false, error: cause?.message || '加载目录失败' } };
  }
}

function loadRoot() {
  if (selectedWorkspaceId.value) loadDir(ROOT_PATH);
}

// 切项目 = 换一棵树：目录状态、展开集合、选中文件全部重置
watch(selectedWorkspaceId, () => {
  dirs.value = {};
  expandedPaths.value = [];
  selectedPath.value = '';
  loadRoot();
}, { immediate: true });

function onToggleDir(path) {
  if (expandedPaths.value.includes(path)) {
    expandedPaths.value = expandedPaths.value.filter((item) => item !== path);
    return;
  }
  expandedPaths.value = [...expandedPaths.value, path];
  const dir = dirs.value[path];
  if (!dir || dir.status === 'error') loadDir(path);
}

function onSelectFile(path) {
  selectedPath.value = path;
  sessionRunStore.openWorkbenchFile({ workspaceId: selectedWorkspaceId.value, path });
  // 移动端：侧栏是抽屉，选中文件后收起才能看到右侧工作台
  shellSidebarControl?.closeMobileSidebar?.();
}

function selectWorkspace(id) {
  if (!id || id === selectedWorkspaceId.value) return;
  selectedWorkspaceId.value = id;
  emit('update:workspace-id', id);
}

function refresh() {
  const loaded = Object.keys(dirs.value).filter((key) => dirs.value[key]?.status === 'loaded');
  if (selectedWorkspaceId.value && !loaded.includes(ROOT_PATH)) loaded.push(ROOT_PATH);
  for (const key of loaded) loadDir(key);
  if (loaded.some((key) => dirs.value[key]?.status === 'error')) {
    toast.show('部分目录刷新失败', 'error');
  }
}

defineExpose({ refresh });
</script>

<style scoped>
.workspace-file-nav {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 6px;
  padding: 0 2px 4px;
}

.workspace-file-nav__toolbar {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: 34px;
  padding: 0 8px;
}

.workspace-file-nav__picker {
  flex: 0 0 auto;
  padding: 0 8px;
}

.workspace-file-nav__picker-trigger {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius-sm);
  padding: 5px 8px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  text-align: left;
}

.workspace-file-nav__picker-trigger:hover {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.workspace-file-nav__picker-trigger svg {
  width: 14px;
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.workspace-file-nav__picker-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-weight: var(--font-weight-medium, 500);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-file-nav__body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
}

/* 树行收紧到 24px（SkillFileTree 默认 30px；仅本导航内覆盖，不影响技能库面板） */
.workspace-file-nav__body :deep(.file-row) {
  min-height: 24px;
  padding-top: 2px;
  padding-bottom: 2px;
}

.workspace-file-nav__hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 24px 16px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-align: center;
}

.workspace-file-nav__hint svg {
  width: 20px;
  height: 20px;
  opacity: 0.7;
}

.workspace-file-nav__hint.is-error {
  color: var(--color-text-secondary);
}

.workspace-file-nav__truncated {
  flex: 0 0 auto;
  padding: 6px 10px;
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
  text-align: center;
}
</style>
