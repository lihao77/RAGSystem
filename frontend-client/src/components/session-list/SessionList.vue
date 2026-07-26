<template>
  <section class="flex min-h-0 flex-1 flex-col gap-2" aria-label="最近会话">
    <div class="flex h-6 shrink-0 items-center justify-between px-3">
      <h2 class="text-xs font-semibold uppercase leading-none tracking-wider text-muted-foreground">最近会话</h2>
      <Button
        v-if="hasFilters"
        variant="ghost"
        size="icon-xs"
        class="size-6 shrink-0 p-0 leading-none"
        :disabled="loadingInitial"
        aria-label="清除筛选"
        title="清除筛选"
        @click="clearFilters"
      >
        <FilterX data-icon="inline-start" />
      </Button>
    </div>

    <SessionListToolbar
      :facets="facets"
      :filters="filters"
      :disabled="loadingInitial || (loadingFacets && !hasFacetData)"
      @filter="applyFilters"
    />

    <div ref="scrollContainer" class="min-h-0 flex-1 overflow-y-auto px-2" @scroll="handleScroll">
      <div v-if="loadingInitial" class="flex flex-col gap-2 p-1">
        <div v-for="index in 6" :key="index" class="flex items-center gap-2 p-2">
          <Skeleton class="size-4 shrink-0" />
          <span class="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton class="h-3 w-4/5" />
            <Skeleton class="h-3 w-3/5" />
          </span>
        </div>
      </div>

      <Empty v-else-if="error && !items.length" class="py-8">
        <EmptyHeader>
          <EmptyTitle>会话加载失败</EmptyTitle>
          <EmptyDescription>{{ error }}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" @click="retry">重试</Button>
        </EmptyContent>
      </Empty>

      <Empty v-else-if="!items.length" class="py-8">
        <EmptyHeader>
          <EmptyTitle>没有匹配的会话</EmptyTitle>
          <EmptyDescription>调整来源或 Workspace 筛选后再试。</EmptyDescription>
        </EmptyHeader>
      </Empty>

      <TooltipProvider v-else>
        <TransitionGroup name="session-list" tag="div" class="flex flex-col gap-0.5">
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
      </TooltipProvider>

      <div v-if="loadingMore" class="flex flex-col gap-2 p-3">
        <Skeleton class="h-3 w-4/5" />
        <Skeleton class="h-3 w-3/5" />
      </div>
      <div v-else-if="error && items.length" class="flex items-center justify-center gap-2 p-3">
        <span class="text-xs text-muted-foreground">{{ error }}</span>
        <Button variant="ghost" size="xs" @click="retry">重试</Button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import type { SessionListItem as SessionListItemData } from '@ragsystem/api-contracts';
import { FilterX } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipProvider } from '@/components/ui/tooltip';
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
</style>
