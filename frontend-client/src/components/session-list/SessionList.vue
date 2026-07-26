<template>
  <section class="flex min-h-0 flex-1 flex-col gap-2" aria-label="最近会话">
    <div class="flex h-7 shrink-0 items-center justify-between gap-2 px-2">
      <div class="flex min-w-0 items-center gap-2 px-1">
        <h2 class="text-xs font-semibold uppercase leading-none tracking-wider text-muted-foreground">
          最近会话
        </h2>
        <span
          v-if="hasFilters && !loadingInitial"
          class="truncate text-[11px] leading-none text-muted-foreground"
        >
          {{ items.length ? `${items.length}${hasMore ? '+' : ''}` : '无结果' }}
        </span>
      </div>
      <SessionListToolbar
        :facets="facets"
        :filters="filters"
        :disabled="loadingInitial || (loadingFacets && !hasFacetData)"
        @filter="applyFilters"
        @clear="clearFilters"
      />
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

          <Empty v-else-if="!items.length && hasFilters" key="filtered-empty" class="py-8">
            <EmptyHeader>
              <EmptyTitle>没有符合条件的会话</EmptyTitle>
              <EmptyDescription>当前来源或工作区筛选下没有结果。</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" @click="clearFilters">清除筛选</Button>
            </EmptyContent>
          </Empty>

          <Empty v-else-if="!items.length" key="empty" class="py-8">
            <EmptyHeader>
              <EmptyTitle>还没有会话</EmptyTitle>
              <EmptyDescription>点上方「新聊天」开始第一段对话。</EmptyDescription>
            </EmptyHeader>
          </Empty>

          <div v-else key="list" class="flex flex-col gap-0.5">
            <TransitionGroup name="session-list" tag="div" class="session-list-items flex flex-col gap-0.5">
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
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { useSessionListStore } from '@/stores/session-list.js';
import { useSessionListTime } from '@/composables/useSessionListTime.js';
import SessionListItem from './SessionListItem.vue';
import SessionListToolbar from './SessionListToolbar.vue';

defineProps<{
  activeSessionId?: string | null;
}>();

defineEmits<{
  select: [item: SessionListItemData];
  delete: [item: SessionListItemData];
}>();

const store = useSessionListStore();
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
.session-list-scroll {
  transition: opacity 180ms ease;
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
