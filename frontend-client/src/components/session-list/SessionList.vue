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
              <EmptyDescription>当前来源或工作区筛选下没有结果。</EmptyDescription>
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

          <Empty v-else-if="viewMode === 'project' && !projectGroups.length" key="project-empty" class="py-8">
            <EmptyHeader>
              <EmptyTitle>还没有项目对话</EmptyTitle>
              <EmptyDescription>选择一个项目后，从上方新聊天开始。</EmptyDescription>
            </EmptyHeader>
          </Empty>

          <div v-else key="list" class="flex flex-col gap-0.5">
            <template v-if="viewMode === 'project'">
              <section v-for="group in projectGroups" :key="group.id" class="project-session-group">
                <div
                  class="project-session-group__header"
                  :class="{ 'is-selected': group.id === currentWorkspaceId }"
                >
                  <button
                    type="button"
                    class="project-session-group__select"
                    @click="$emit('select-workspace', group.workspace)"
                  >
                    <FolderOpen class="project-session-group__icon" aria-hidden="true" />
                    <span class="min-w-0 flex-1 truncate">{{ group.name }}</span>
                    <span class="project-session-group__count">{{ group.items.length || '' }}</span>
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
                          @select="$emit('remove-workspace', group.workspace)"
                        >
                          <FolderMinus />
                          移除项目
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
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
                <div v-else class="project-session-group__empty">暂无对话</div>
              </section>
            </template>

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
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import type { SessionListItem as SessionListItemData } from '@ragsystem/api-contracts';
import { Ellipsis, FolderMinus, FolderOpen } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
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
import { useWorkspaceStore } from '@/stores/workspace.js';
import { useSessionListTime } from '@/composables/useSessionListTime.js';
import SessionListItem from './SessionListItem.vue';
import SessionListToolbar from './SessionListToolbar.vue';
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
  'remove-workspace': [workspace: { workspace_id: string; display_name: string; root_path?: string | null }];
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
  error,
  hasMore,
} = storeToRefs(store);
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
const projectGroups = computed(() => {
  if (props.viewMode !== 'project') return [];
  const groups = new Map();
  for (const workspace of workspaceItems.value) {
    groups.set(workspace.workspace_id, { id: workspace.workspace_id, name: workspace.display_name, workspace, items: [] });
  }
  for (const item of items.value) {
    const id = item.workspace?.workspace_id || '__unassigned__';
    if (!groups.has(id) && id === '__unassigned__') {
      groups.set(id, {
        id,
        name: '未归属项目',
        workspace: null,
        items: [],
      });
    }
    if (!groups.has(id)) continue;
    groups.get(id).items.push(item);
  }
  return Array.from(groups.values());
});

function applyFilters(next: Partial<typeof filters.value>) {
  void store.setFilters(next).catch(() => undefined);
  if (scrollContainer.value) scrollContainer.value.scrollTop = 0;
}

function clearFilters() {
  void store.clearFilters().catch(() => undefined);
  if (scrollContainer.value) scrollContainer.value.scrollTop = 0;
}

function handleScroll() {
  const element = scrollContainer.value;
  if (!element || loadingMore.value || loadingInitial.value || !hasMore.value) return;
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 80) {
    void store.load().catch(() => undefined);
  }
}

function retry() {
  void store.load({ reset: items.value.length === 0 }).catch(() => undefined);
}

onMounted(() => {
  if (!items.value.length) void store.initialize().catch(() => undefined);
  else void store.loadFacets().catch(() => undefined);
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
  display: flex;
  min-width: 0;
  width: 100%;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 2px 3px 2px 0;
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

.project-session-group__select {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 3px 4px 3px 7px;
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

.project-session-group__items {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
  padding-left: 21px;
}

.project-session-group__empty {
  padding: 5px 8px 7px 31px;
  color: var(--color-text-muted);
  font-size: 12px;
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
