<template>
  <section class="flex min-h-0 flex-1 flex-col gap-2" aria-label="最近会话">
    <div class="workspace-sidebar-toolbar">
      <SessionBrowserViewToggle
        :model-value="viewMode || 'project'"
        @update:model-value="$emit('update:view-mode', $event)"
      />
      <div class="workspace-sidebar-actions">
        <SessionListToolbar
          compact
          :facets="facets"
          :filters="filters"
          :disabled="loadingInitial || (loadingFacets && !hasFacetData)"
          @filter="applyFilters"
          @clear="clearFilters"
        />
        <WorkspacePicker
          v-if="viewMode === 'project'"
          :chat-sdk-client="chatSdkClient"
          @change="$emit('select-workspace', $event)"
        />
      </div>
    </div>

    <div class="session-list-body relative min-h-0 flex-1">
      <!-- 有内容时刷新：顶部细进度，不整表换骨架 -->
      <div
        v-if="isSoftRefreshing"
        class="session-list-progress"
        aria-hidden="true"
      />

      <div
        ref="scrollContainer"
        class="session-list-scroll min-h-0 h-full overflow-y-auto px-2"
        :class="{ 'is-soft-refreshing': isSoftRefreshing }"
        @scroll="handleScroll"
      >
        <Transition name="session-stage" mode="out-in">
          <!-- 冷启动 / 筛到空后的首屏加载：骨架 -->
          <div v-if="showSkeleton" key="skeleton" class="flex flex-col gap-2 p-1">
            <div v-for="index in 6" :key="index" class="flex items-center gap-2 px-1 py-1.5">
              <span class="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton class="h-3.5 w-4/5" />
                <Skeleton class="h-3 w-2/5" />
              </span>
              <Skeleton class="h-3 w-8 shrink-0" />
            </div>
          </div>

          <Empty v-else-if="error && !items.length" key="error" class="py-8">
            <EmptyHeader>
              <EmptyTitle>会话加载失败</EmptyTitle>
              <EmptyDescription>{{ error }}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" @click="retry">重试</Button>
            </EmptyContent>
          </Empty>

          <Empty v-else-if="viewMode !== 'project' && !items.length && hasFilters" key="filtered-empty" class="py-8">
            <EmptyHeader>
              <EmptyTitle>没有符合条件的会话</EmptyTitle>
              <EmptyDescription>当前来源或项目筛选下没有结果。</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" @click="clearFilters">清除筛选</Button>
            </EmptyContent>
          </Empty>

          <Empty v-else-if="!items.length && viewMode !== 'project'" key="empty" class="py-8">
            <EmptyHeader>
              <EmptyTitle>还没有会话</EmptyTitle>
              <EmptyDescription>点上方「新聊天」开始第一段对话。</EmptyDescription>
            </EmptyHeader>
          </Empty>

          <Empty v-else-if="viewMode === 'project' && !workspaceItems.length && !items.length" key="project-empty" class="py-8">
            <EmptyHeader>
              <EmptyTitle>还没有项目对话</EmptyTitle>
              <EmptyDescription>添加一个本地项目，或直接开始聊天。</EmptyDescription>
            </EmptyHeader>
          </Empty>

          <div v-else key="list" class="flex flex-col gap-0.5">
            <TransitionGroup
              v-if="viewMode === 'project'"
              name="project-group"
              tag="div"
              class="project-groups"
              @dragover.prevent
              @drop.prevent="onGroupsDrop"
            >
              <section v-for="group in projectGroups" :key="group.id" class="project-session-group">
                <div
                  class="project-session-group__header"
                  :class="{
                    'is-selected': group.id === currentWorkspaceId,
                    'is-dragging': dragState.id === group.id,
                  }"
                  :draggable="Boolean(group.workspace)"
                  :aria-label="group.workspace ? `拖拽可调整「${group.name}」的顺序` : undefined"
                  @dragstart="onGroupDragStart($event, group)"
                  @drag="onGroupDrag"
                  @dragover="onGroupDragOver($event, group)"
                  @dragend="onGroupDragEnd"
                >
                  <button
                    type="button"
                    class="project-session-group__toggle"
                    :aria-expanded="!isCollapsed(group.id)"
                    :aria-label="isCollapsed(group.id) ? `展开 ${group.name}` : `折叠 ${group.name}`"
                    :title="isCollapsed(group.id) ? `展开 ${group.name}` : `折叠 ${group.name}`"
                    @click.stop="toggleCollapsed(group.id)"
                  >
                    <FolderOpen v-if="!isCollapsed(group.id)" class="project-session-group__icon" aria-hidden="true" />
                    <Folder v-else class="project-session-group__icon" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="project-session-group__select"
                    @click="$emit('select-workspace', group.workspace)"
                  >
                    <span class="min-w-0 flex-1 truncate">{{ group.name }}</span>
                    <span class="project-session-group__count">{{ (group.workspace?.session_count ?? group.items.length) || '' }}</span>
                  </button>
                  <DropdownMenu v-if="group.workspace">
                    <DropdownMenuTrigger as-child>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        :disabled="removingWorkspaceId === group.id"
                        :aria-label="`管理项目 ${group.name}`"
                        :title="`管理项目 ${group.name}`"
                      >
                        <Ellipsis />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          :disabled="removingWorkspaceId === group.id"
                          @select="$emit('rename-workspace', group.workspace)"
                        >
                          <Pencil />
                          重命名项目
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          :disabled="removingWorkspaceId === group.id"
                          @select="$emit('remove-workspace', group.workspace)"
                        >
                          <FolderMinus />
                          移除项目
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        class="text-destructive focus:text-destructive"
                        :disabled="removingWorkspaceId === group.id"
                        @select="$emit('purge-workspace', group.workspace)"
                      >
                        <Trash2 />
                        移除项目并删除会话
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <GroupCollapseBody :open="!isCollapsed(group.id)">
                  <div v-if="group.items.length" class="project-session-group__items">
                    <SessionListItem
                      v-for="item in group.items"
                      :key="item.session_id"
                      :item="item"
                      :active="item.session_id === activeSessionId"
                      :now="now"
                      compact
                      @select="$emit('select', item)"
                      @delete="$emit('delete', item)"
                    />
                  </div>
                  <div v-else-if="!workspaceHasMore(group.id)" class="project-session-group__empty">暂无对话</div>
                  <button
                    v-if="workspaceHasMore(group.id)"
                    type="button"
                    class="project-session-group__more"
                    :disabled="Boolean(loadingWorkspaceIds[group.id])"
                    @click="loadGroupMore(group)"
                  >
                    <template v-if="loadingWorkspaceIds[group.id]">加载中…</template>
                    <template v-else-if="groupErrors[group.id]">加载失败 · 点击重试</template>
                    <template v-else>加载更多</template>
                  </button>
                </GroupCollapseBody>
              </section>
            </TransitionGroup>

            <TransitionGroup v-else name="session-list" tag="div" class="session-list-items flex flex-col gap-0.5">
              <SessionListItem
                v-for="item in items"
                :key="item.session_id"
                :item="item"
                :active="item.session_id === activeSessionId"
                :now="now"
                @select="$emit('select', item)"
                @delete="$emit('delete', item)"
              />
            </TransitionGroup>

            <div v-if="loadingMore" class="flex flex-col gap-2 p-3">
              <Skeleton class="h-3 w-4/5" />
              <Skeleton class="h-3 w-3/5" />
            </div>
            <div v-else-if="error && items.length" class="flex items-center justify-center gap-2 p-3">
              <span class="text-xs text-muted-foreground">{{ error }}</span>
              <Button variant="ghost" size="xs" @click="retry">重试</Button>
            </div>
          </div>
        </Transition>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import type { SessionListItem as SessionListItemData } from '@ragsystem/api-contracts';
import { Ellipsis, Folder, FolderMinus, FolderOpen, Pencil, Trash2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { useSessionListStore } from '@/stores/session-list.js';
import { UNASSIGNED_WORKSPACE_ID, useWorkspaceStore } from '@/stores/workspace.js';
import { useSessionListTime } from '@/composables/useSessionListTime.js';
import SessionListItem from './SessionListItem.vue';
import SessionListToolbar from './SessionListToolbar.vue';
import GroupCollapseBody from './GroupCollapseBody.vue';
import SessionBrowserViewToggle from '@/components/workspace/SessionBrowserViewToggle.vue';
import WorkspacePicker from '@/components/workspace/WorkspacePicker.vue';

const props = defineProps<{
  activeSessionId?: string | null;
  chatSdkClient: object;
  viewMode?: string;
}>();

defineEmits<{
  select: [item: SessionListItemData];
  delete: [item: SessionListItemData];
  'update:view-mode': [view: string];
  'select-workspace': [workspace: { workspace_id: string; display_name: string; root_path?: string | null } | null];
  'rename-workspace': [workspace: { workspace_id: string; display_name: string; root_path?: string | null }];
  'remove-workspace': [workspace: { workspace_id: string; display_name: string; root_path?: string | null }];
  'purge-workspace': [workspace: { workspace_id: string; display_name: string; root_path?: string | null; session_count?: number }];
}>();

const store = useSessionListStore();
const workspaceStore = useWorkspaceStore();
const {
  items,
  filters,
  facets,
  loadingInitial,
  loadingMore,
  loadingFacets,
  loadingWorkspaceIds,
  error,
  hasMore,
} = storeToRefs(store);
/** setup store 的动作是闭包，解构不丢响应式上下文 */
const workspaceHasMore = store.workspaceHasMore;
const { isCollapsed, toggleCollapsed } = workspaceStore;
const { items: workspaceItems, currentWorkspaceId, removingWorkspaceId } = storeToRefs(workspaceStore);
const now = useSessionListTime();
const scrollContainer = ref<HTMLElement | null>(null);
const hasFilters = computed(() => Boolean(filters.value.originType || filters.value.workspaceId));
const hasFacetData = computed(() => (
  Object.values(facets.value.type_counts).some(count => count > 0)
  || facets.value.origins.length > 0
  || facets.value.workspaces.length > 0
));

/** 已有列表时筛选/刷新：保留内容做软刷新，避免整表骨架硬切 */
const isSoftRefreshing = computed(() => loadingInitial.value && items.value.length > 0);
/** 仅冷启动或筛空后的加载才用骨架 */
const showSkeleton = computed(() => loadingInitial.value && items.value.length === 0);

/** 组头拖拽排序状态：id=被拖组；previewIds=实时预览顺序；originIds=拖起前顺序（未变则不持久化）；wasCollapsed=拖起前的折叠态（释放后恢复） */
const dragState = ref<{ id: string | null; previewIds: string[] | null; originIds: string[] | null; wasCollapsed: boolean }>({
  id: null,
  previewIds: null,
  originIds: null,
  wasCollapsed: false,
});

/** 拖起即折叠被拖分组（内容收起、列表变短），释放后按拖起前的状态恢复展开。 */
function collapseForDrag(id: string) {
  const wasCollapsed = isCollapsed(id);
  if (!wasCollapsed) toggleCollapsed(id);
  return wasCollapsed;
}

function restoreAfterDrag(id: string | null, wasCollapsed: boolean) {
  if (id && !wasCollapsed && isCollapsed(id)) toggleCollapsed(id);
}

function onGroupDragStart(event: DragEvent, group: { id: string; workspace?: unknown }) {
  if (!group.workspace) {
    event.preventDefault();
    return;
  }
  const wasCollapsed = collapseForDrag(group.id);
  const originIds = workspaceItems.value.map(item => item.workspace_id);
  dragState.value = {
    id: group.id,
    previewIds: originIds,
    originIds,
    wasCollapsed,
  };
  event.dataTransfer?.setData('text/plain', group.id);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    // 隐藏原生拖影，改用自制幽灵：横向锁定在原位，仅纵向跟随
    event.dataTransfer.setDragImage(ensureEmptyDragImage(), 0, 0);
  }
  mountDragGhost(event);
}

/** 自制拖拽幽灵：克隆被拖组头，position fixed，left 恒为拖起时的原位。 */
let dragGhost: HTMLElement | null = null;
let dragGhostGrabOffsetY = 0;
let emptyDragImageEl: HTMLCanvasElement | null = null;

function ensureEmptyDragImage(): HTMLCanvasElement {
  if (!emptyDragImageEl) emptyDragImageEl = document.createElement('canvas');
  return emptyDragImageEl;
}

function mountDragGhost(event: DragEvent) {
  const header = event.currentTarget as HTMLElement;
  const rect = header.getBoundingClientRect();
  dragGhostGrabOffsetY = event.clientY - rect.top;
  const ghost = header.cloneNode(true) as HTMLElement;
  ghost.classList.add('project-drag-ghost');
  ghost.style.position = 'fixed';
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  ghost.style.width = `${rect.width}px`;
  ghost.style.margin = '0';
  ghost.style.pointerEvents = 'none';
  document.body.appendChild(ghost);
  dragGhost = ghost;
}

/** drag 事件持续携带指针坐标：只更新 top（仅纵向移动），left 永不变。 */
function onGroupDrag(event: DragEvent) {
  if (!dragGhost || (!event.clientY && !event.clientX)) return;
  dragGhost.style.top = `${event.clientY - dragGhostGrabOffsetY}px`;
}

function removeDragGhost() {
  dragGhost?.remove();
  dragGhost = null;
}

/** 悬停到目标分组：按指针在组头的上/下半区决定插入到其前/后，实时更新预览顺序。 */
function onGroupDragOver(event: DragEvent, group: { id: string; workspace?: unknown }) {
  const draggedId = dragState.value.id;
  if (!draggedId || !group.workspace || group.id === draggedId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const ids = [...(dragState.value.previewIds ?? [])];
  const from = ids.indexOf(draggedId);
  if (from < 0) return;
  ids.splice(from, 1);
  const target = ids.indexOf(group.id);
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const before = event.clientY <= rect.top + rect.height / 2;
  if (target < 0) ids.push(draggedId);
  else if (before) ids.splice(target, 0, draggedId);
  else ids.splice(target + 1, 0, draggedId);
  if (ids.join('\u0000') !== (dragState.value.previewIds ?? []).join('\u0000')) {
    dragState.value = { ...dragState.value, previewIds: ids };
  }
}

/**
 * 容器级 drop：预览排序后鼠标下方往往是被拖分组自己的占位（其组头未 preventDefault，
 * 浏览器不视为有效目标），因此整个分组容器统一作为放置区，这里一次提交预览顺序。
 */
function onGroupsDrop() {
  removeDragGhost();
  const { id, previewIds, originIds, wasCollapsed } = dragState.value;
  if (!id) return;
  dragState.value = { id: null, previewIds: null, originIds: null, wasCollapsed: false };
  // 原地释放（未移动位置）不固化自定义顺序，保持默认的名称排序模式
  if (previewIds?.length && previewIds.join('\u0000') !== originIds?.join('\u0000')) {
    workspaceStore.reorder(previewIds);
  }
  restoreAfterDrag(id, wasCollapsed);
}

/** dragend 兜底取消场景（Esc、拖出列表释放）：移除幽灵、还原预览顺序并恢复展开。 */
function onGroupDragEnd() {
  removeDragGhost();
  const { id, wasCollapsed } = dragState.value;
  if (!id) return;
  dragState.value = { id: null, previewIds: null, originIds: null, wasCollapsed: false };
  restoreAfterDrag(id, wasCollapsed);
}

/**
 * 项目视图分组：组 id 即工作区 id（未归属组为 __unassigned__），已加载条目全部直接渲染。
 * 未归属组常驻末位——即使暂无未归属会话，也能一键切回“不指定项目”。
 * 拖拽期间按 previewIds 实时预览排序，其他分组游动让位。
 */
const projectGroups = computed(() => {
  if (props.viewMode !== 'project') return [];
  const previewRank = dragState.value.previewIds?.length
    ? new Map(dragState.value.previewIds.map((id, index) => [id, index]))
    : null;
  const orderedWorkspaces = previewRank
    ? [...workspaceItems.value].sort((a, b) => (
      (previewRank.get(a.workspace_id) ?? workspaceItems.value.length)
        - (previewRank.get(b.workspace_id) ?? workspaceItems.value.length)
    ))
    : workspaceItems.value;
  const groups = new Map();
  for (const workspace of orderedWorkspaces) {
    groups.set(workspace.workspace_id, { id: workspace.workspace_id, name: workspace.display_name, workspace, items: [] });
  }
  groups.set(UNASSIGNED_WORKSPACE_ID, { id: UNASSIGNED_WORKSPACE_ID, name: '未归属项目', workspace: null, items: [] });
  for (const item of items.value) {
    const group = groups.get(item.workspace?.workspace_id || UNASSIGNED_WORKSPACE_ID);
    if (group) group.items.push(item);
  }
  return Array.from(groups.values());
});

/** 组级取页失败标记：按钮文案转为“点击重试”，不弹全局错误 */
const groupErrors = ref<Record<string, boolean>>({});

/** 组内「加载更多」：项目视图唯一翻页入口，取该项目自己的下一页 */
function loadGroupMore(group: { id: string }) {
  groupErrors.value = { ...groupErrors.value, [group.id]: false };
  void store.loadWorkspace(group.id).catch(() => {
    groupErrors.value = { ...groupErrors.value, [group.id]: true };
  });
}

/** 时间轴视图沿用滚动到底自动翻页；项目视图每组按自己的工作区游标独立翻页 */
function handleScroll() {
  if (props.viewMode === 'project') return;
  const element = scrollContainer.value;
  if (!element || loadingMore.value || loadingInitial.value || !hasMore.value) return;
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 80) {
    void store.load().catch(() => undefined);
  }
}

function applyFilters(next: Partial<typeof filters.value>) {
  void store.setFilters(next).catch(() => undefined);
  if (scrollContainer.value) scrollContainer.value.scrollTop = 0;
}

function clearFilters() {
  void store.clearFilters().catch(() => undefined);
  if (scrollContainer.value) scrollContainer.value.scrollTop = 0;
}

function retry() {
  void store.load({ reset: items.value.length === 0 }).catch(() => undefined);
}

function requestProjectPreview() {
  if (props.viewMode === 'project' && !loadingInitial.value) {
    void store.loadWorkspacePreview().catch(() => undefined);
  }
}

onMounted(() => {
  if (!items.value.length) {
    // 冷启动先等初始全局页落定再取预览，避免请求刚发出就被 initialize 的 reset 中止
    void store.initialize().catch(() => undefined).finally(requestProjectPreview);
  } else {
    void store.loadFacets().catch(() => undefined);
    requestProjectPreview();
  }
});

/** 项目视图首屏靠预览接口补齐每个项目自己的最新一页；也覆盖运行中切换视图/筛选重置的场景 */
watch(
  [() => props.viewMode, loadingInitial],
  ([mode, loading]) => {
    if (mode === 'project' && !loading) void store.loadWorkspacePreview().catch(() => undefined);
  },
);

/** 筛选重置会作废全部工作区游标，组级失败标记一并清空 */
watch(filters, () => {
  groupErrors.value = {};
});
</script>

<style scoped>
.workspace-sidebar-toolbar {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: 34px;
  padding: 0 8px;
}

.workspace-sidebar-toolbar > :first-child {
  min-width: 0;
  flex: 0 1 auto;
}

.workspace-sidebar-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
}

.session-list-scroll {
  transition: opacity 180ms ease;
}

.project-session-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}

.project-session-group__header {
  position: relative;
  display: flex;
  min-width: 0;
  width: 100%;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  /* 左内边距对齐「新聊天」按钮图标起点（侧栏 8px 容器 + 8px 按钮内边距 = 16px） */
  padding: 2px 3px 2px 8px;
  border: 1px dashed transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.project-session-group__header:hover {
  background: var(--color-active-bg);
  color: var(--color-text-primary);
}

.project-session-group__header.is-selected {
  color: var(--color-text-primary);
  font-weight: 600;
}

/* 折叠开关即文件夹图标本身：展开=FolderOpen，折叠=Folder（无 hover 反馈，避免与组头选中态抢焦点） */
.project-session-group__toggle {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 24px;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}

/* 拖拽排序反馈：被拖分组留在原列表中作为占位（虚线框 + 半透明），其余分组游动让位 */
.project-session-group__header[draggable='true'] {
  cursor: grab;
}

.project-session-group__header.is-dragging {
  opacity: 0.55;
  border-color: var(--color-border);
  border-style: dashed;
}

/* TransitionGroup FLIP：预览顺序变化时其余分组平滑游动 */
.project-groups {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.project-group-move {
  transition: transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.project-group-leave-active {
  position: absolute;
  left: 0;
  right: 0;
  opacity: 0;
  transition: opacity 160ms ease;
}

/* 自制拖拽幽灵：悬浮阴影 + 不透明底，left 由内联样式锁定在拖起时的原位（仅纵向移动） */
.project-drag-ghost {
  z-index: 1000;
  background: var(--surface-sidebar);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  opacity: 0.92;
  will-change: top;
}

.project-session-group__select {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 3px 4px 3px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.project-session-group__icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--color-text-muted);
}

.project-session-group__count {
  min-width: 16px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* 会话条目缩进对齐项目名（项目名文字 = 内容区 8px + 组头 8px 内边距 + 图标 14px + 间距 8px = 38px；条目根节点与按钮各带 4px 内边距，共 8px） */
.project-session-group__items {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
  padding-left: 22px;
}

.project-session-group__empty {
  padding: 5px 8px 7px 30px;
  color: var(--color-text-muted);
  font-size: 12px;
}

/* 分组「加载更多」：与组内条目同缩进的弱化文字按钮，项目视图唯一翻页入口 */
.project-session-group__more {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  margin: 1px 0 2px;
  padding: 4px 6px 5px 30px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.project-session-group__more:hover:not(:disabled) {
  background: var(--color-active-bg);
  color: var(--color-text-primary);
}

.project-session-group__more:disabled {
  cursor: default;
  opacity: 0.6;
}

.session-list-scroll.is-soft-refreshing {
  opacity: 0.55;
  pointer-events: none;
}

.session-list-progress {
  position: absolute;
  top: 0;
  left: 8px;
  right: 8px;
  z-index: 1;
  height: 2px;
  overflow: hidden;
  border-radius: 999px;
  background: transparent;
  pointer-events: none;
}

.session-list-progress::after {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 40%;
  border-radius: inherit;
  background: var(--color-brand-accent, hsl(var(--primary)));
  animation: session-list-indeterminate 900ms ease-in-out infinite;
}

@keyframes session-list-indeterminate {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(350%); }
}

/* 列表 / 空态 / 骨架 之间的切换 */
.session-stage-enter-active,
.session-stage-leave-active {
  transition: opacity 160ms ease, transform 180ms ease;
}

.session-stage-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.session-stage-leave-to {
  opacity: 0;
  transform: translateY(-3px);
}

/* 单项进出（客户端即时过滤 / 服务端回填） */
.session-list-items {
  position: relative;
}

.session-list-move,
.session-list-enter-active,
.session-list-leave-active {
  transition: opacity 160ms ease, transform 200ms ease;
}

.session-list-enter-from,
.session-list-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.session-list-leave-active {
  position: absolute;
  left: 0;
  right: 0;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .session-list-scroll,
  .project-group-move,
  .session-stage-enter-active,
  .session-stage-leave-active,
  .session-list-move,
  .session-list-enter-active,
  .session-list-leave-active {
    transition: none;
  }

  .session-list-progress::after {
    animation: none;
    width: 100%;
    opacity: 0.6;
  }

  .session-list-scroll.is-soft-refreshing {
    opacity: 0.7;
  }
}
</style>
