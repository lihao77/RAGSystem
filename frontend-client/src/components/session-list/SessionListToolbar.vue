<template>
  <div class="flex h-8 shrink-0 min-w-0 items-center gap-2 px-2">
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="outline" size="sm" class="min-w-0 flex-1 justify-between" :disabled="disabled">
          <span class="truncate leading-none">{{ sourceLabel }}</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>来源</DropdownMenuLabel>
          <DropdownMenuRadioGroup :model-value="selectedSourceKey" @update:model-value="selectSourceKey">
            <DropdownMenuRadioItem
              v-for="option in sourceOptions"
              :key="option.key"
              :value="option.key"
            >
              <span class="truncate" :class="cn(option.selected && 'font-medium')">{{ option.label }}</span>
              <span class="ml-auto text-xs text-muted-foreground">{{ option.count }}</span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button
          variant="outline"
          size="sm"
          class="min-w-0 max-w-28"
          :disabled="disabled || !facets.workspaces.length"
          :aria-label="workspaceLabel"
          :title="workspaceLabel"
        >
          <span class="truncate leading-none">{{ selectedWorkspace?.display_name || 'Workspace' }}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Workspace</DropdownMenuLabel>
          <DropdownMenuRadioGroup :model-value="selectedWorkspaceKey" @update:model-value="selectWorkspaceKey">
            <DropdownMenuRadioItem value="all-workspaces">
              <span :class="cn(!filters.workspaceId && 'font-medium')">全部 Workspace</span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem
              v-for="workspace in facets.workspaces"
              :key="workspace.workspace_id"
              :value="`workspace:${workspace.workspace_id}`"
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate" :class="cn(filters.workspaceId === workspace.workspace_id && 'font-medium')">
                  {{ workspace.display_name }}
                </span>
                <span v-if="workspace.root_path" class="block truncate text-xs text-muted-foreground">
                  {{ workspace.root_path }}
                </span>
              </span>
              <span class="text-xs text-muted-foreground">{{ workspace.count }}</span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { SessionListFacets, SessionOriginType } from '@ragsystem/api-contracts';
import { ChevronDown } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface SessionListFilters {
  originType: SessionOriginType | null;
  originId: string | null;
  workspaceId: string | null;
}

const props = defineProps<{
  facets: SessionListFacets;
  filters: SessionListFilters;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  filter: [filters: Partial<SessionListFilters>];
}>();

const totalCount = computed(() => Object.values(props.facets.type_counts).reduce((sum, count) => sum + count, 0));
const sourceOptions = computed(() => [
  { key: 'all', type: null, id: null, label: '全部来源', count: totalCount.value },
  { key: 'direct', type: 'direct', id: null, label: '直接对话', count: props.facets.type_counts.direct },
  { key: 'bot', type: 'bot', id: null, label: '全部 Bot', count: props.facets.type_counts.bot },
  ...props.facets.origins
    .filter(origin => origin.type === 'bot')
    .map(origin => ({ key: `bot-${origin.id}`, type: 'bot', id: origin.id, label: `Bot · ${origin.display_name}`, count: origin.count })),
  { key: 'widget', type: 'widget', id: null, label: '全部 Widget', count: props.facets.type_counts.widget },
  ...props.facets.origins
    .filter(origin => origin.type === 'widget')
    .map(origin => ({ key: `widget-${origin.id}`, type: 'widget', id: origin.id, label: `Widget · ${origin.display_name}`, count: origin.count })),
].map(option => ({
  ...option,
  selected: props.filters.originType === option.type && props.filters.originId === option.id,
})) as Array<{
  key: string;
  type: SessionOriginType | null;
  id: string | null;
  label: string;
  count: number;
  selected: boolean;
}>);
const selectedOrigin = computed(() => props.facets.origins.find(origin => (
  origin.type === props.filters.originType && origin.id === props.filters.originId
)));
const selectedWorkspace = computed(() => props.facets.workspaces.find(workspace => (
  workspace.workspace_id === props.filters.workspaceId
)));
const selectedSourceKey = computed(() => sourceOptions.value.find(option => option.selected)?.key || 'all');
const selectedWorkspaceKey = computed(() => props.filters.workspaceId
  ? `workspace:${props.filters.workspaceId}`
  : 'all-workspaces');
const sourceLabel = computed(() => selectedOrigin.value?.display_name || ({
  direct: '直接对话',
  bot: '全部 Bot',
  widget: '全部 Widget',
}[props.filters.originType || ''] ?? '全部来源'));
const workspaceLabel = computed(() => selectedWorkspace.value
  ? `Workspace：${selectedWorkspace.value.display_name}`
  : '全部 Workspace');

function selectSourceKey(key: string) {
  const option = sourceOptions.value.find(item => item.key === key);
  if (option) emit('filter', { originType: option.type, originId: option.id });
}

function selectWorkspaceKey(key: string) {
  emit('filter', { workspaceId: key === 'all-workspaces' ? null : key.replace(/^workspace:/, '') });
}
</script>
