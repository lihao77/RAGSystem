<template>
  <DropdownMenu v-model:open="open">
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        class="session-filter-btn"
        :class="{
          'is-compact': compact,
          'is-active': hasFilters,
          'is-open': open,
          'is-disabled': disabled,
        }"
        :disabled="disabled"
        :aria-label="ariaLabel"
        :title="ariaLabel"
      >
        <ListFilter class="session-filter-btn__icon" aria-hidden="true" />
        <span v-if="!compact" class="session-filter-btn__label">{{ triggerLabel }}</span>
        <span v-if="activeFilterCount > 0" class="session-filter-btn__badge">
          {{ activeFilterCount }}
        </span>
        <ChevronDown
          v-if="!compact"
          class="session-filter-btn__chevron"
          :class="open && 'is-open'"
          aria-hidden="true"
        />
      </button>
    </DropdownMenuTrigger>

    <DropdownMenuContent align="end" class="w-72 p-0">
      <div class="session-filter-panel">
        <div class="session-filter-panel__section">
          <div class="session-filter-panel__heading">
            <Layers class="size-3.5" aria-hidden="true" />
            <span>来源</span>
          </div>
          <DropdownMenuRadioGroup :model-value="selectedSourceKey" @update:model-value="selectSourceKey">
            <DropdownMenuGroup>
              <DropdownMenuLabel class="sr-only">对话</DropdownMenuLabel>
              <DropdownMenuRadioItem
                v-for="option in dialogueOptions"
                :key="option.key"
                :value="option.key"
                :disabled="option.disabled"
                class="session-filter-item"
                @select.prevent
              >
                <component :is="option.icon" class="session-filter-item__icon" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate" :class="cn(option.selected && 'font-medium')">
                  {{ option.label }}
                </span>
                <span class="session-filter-item__count">{{ option.count }}</span>
              </DropdownMenuRadioItem>
            </DropdownMenuGroup>

            <template v-if="botOptions.length">
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel class="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                  Bot
                </DropdownMenuLabel>
                <DropdownMenuRadioItem
                  v-for="option in botOptions"
                  :key="option.key"
                  :value="option.key"
                  :disabled="option.disabled"
                  class="session-filter-item"
                  @select.prevent
                >
                  <component
                    :is="option.icon"
                    class="session-filter-item__icon"
                    :class="option.indent && 'opacity-70'"
                    aria-hidden="true"
                  />
                  <span
                    class="min-w-0 flex-1 truncate"
                    :class="cn(
                      option.selected && 'font-medium',
                      option.indent && 'text-muted-foreground',
                      option.indent && option.selected && 'text-foreground',
                    )"
                  >
                    {{ option.label }}
                  </span>
                  <span class="session-filter-item__count">{{ option.count }}</span>
                </DropdownMenuRadioItem>
              </DropdownMenuGroup>
            </template>

            <template v-if="widgetOptions.length">
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel class="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                  Widget
                </DropdownMenuLabel>
                <DropdownMenuRadioItem
                  v-for="option in widgetOptions"
                  :key="option.key"
                  :value="option.key"
                  :disabled="option.disabled"
                  class="session-filter-item"
                  @select.prevent
                >
                  <component
                    :is="option.icon"
                    class="session-filter-item__icon"
                    :class="option.indent && 'opacity-70'"
                    aria-hidden="true"
                  />
                  <span
                    class="min-w-0 flex-1 truncate"
                    :class="cn(
                      option.selected && 'font-medium',
                      option.indent && 'text-muted-foreground',
                      option.indent && option.selected && 'text-foreground',
                    )"
                  >
                    {{ option.label }}
                  </span>
                  <span class="session-filter-item__count">{{ option.count }}</span>
                </DropdownMenuRadioItem>
              </DropdownMenuGroup>
            </template>
          </DropdownMenuRadioGroup>
        </div>

        <DropdownMenuSeparator class="my-0" />

        <div class="session-filter-panel__section">
          <div class="session-filter-panel__heading">
            <FolderOpen class="size-3.5" aria-hidden="true" />
            <span>工作区</span>
          </div>
          <DropdownMenuRadioGroup
            :model-value="selectedWorkspaceKey"
            @update:model-value="selectWorkspaceKey"
          >
            <DropdownMenuGroup>
              <DropdownMenuRadioItem
                value="all-workspaces"
                class="session-filter-item"
                :disabled="!facets.workspaces.length && !filters.workspaceId"
                @select.prevent
              >
                <Folders class="session-filter-item__icon" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate" :class="cn(!filters.workspaceId && 'font-medium')">
                  全部工作区
                </span>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem
                v-for="workspace in facets.workspaces"
                :key="workspace.workspace_id"
                :value="`workspace:${workspace.workspace_id}`"
                class="session-filter-item"
                @select.prevent
              >
                <FolderOpen class="session-filter-item__icon" aria-hidden="true" />
                <span class="min-w-0 flex-1">
                  <span
                    class="block truncate"
                    :class="cn(filters.workspaceId === workspace.workspace_id && 'font-medium')"
                  >
                    {{ workspace.display_name }}
                  </span>
                  <span v-if="workspace.root_path" class="block truncate text-xs text-muted-foreground">
                    {{ workspace.root_path }}
                  </span>
                </span>
                <span class="session-filter-item__count">{{ workspace.count }}</span>
              </DropdownMenuRadioItem>
            </DropdownMenuGroup>
          </DropdownMenuRadioGroup>
        </div>

        <div v-if="hasFilters" class="session-filter-panel__footer">
          <button type="button" class="session-filter-clear-all" @click="clearAll">
            <FilterX class="size-3.5" aria-hidden="true" />
            清除全部筛选
          </button>
        </div>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { computed, ref, type Component } from 'vue';
import type { SessionListFacets, SessionOriginType } from '@ragsystem/api-contracts';
import {
  AppWindow,
  Bot,
  ChevronDown,
  FilterX,
  FolderOpen,
  Folders,
  Layers,
  ListFilter,
  MessageSquare,
} from 'lucide-vue-next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface SessionListFilters {
  originType: SessionOriginType | null;
  originId: string | null;
  workspaceId: string | null;
}

interface SourceOption {
  key: string;
  type: SessionOriginType | null;
  id: string | null;
  label: string;
  count: number;
  selected: boolean;
  disabled?: boolean;
  indent?: boolean;
  icon: Component;
}

const props = defineProps<{
  facets: SessionListFacets;
  filters: SessionListFilters;
  disabled?: boolean;
  compact?: boolean;
}>();

const emit = defineEmits<{
  filter: [filters: Partial<SessionListFilters>];
  clear: [];
}>();

const open = ref(false);

const totalCount = computed(() => Object.values(props.facets.type_counts).reduce((sum, count) => sum + count, 0));
const hasSourceFilter = computed(() => Boolean(props.filters.originType));
const hasWorkspaceFilter = computed(() => Boolean(props.filters.workspaceId));
const hasFilters = computed(() => hasSourceFilter.value || hasWorkspaceFilter.value);
const activeFilterCount = computed(() => Number(hasSourceFilter.value) + Number(hasWorkspaceFilter.value));

function isSelected(type: SessionOriginType | null, id: string | null) {
  return props.filters.originType === type && props.filters.originId === id;
}

const dialogueOptions = computed<SourceOption[]>(() => [
  {
    key: 'all',
    type: null,
    id: null,
    label: '全部来源',
    count: totalCount.value,
    selected: isSelected(null, null),
    icon: Layers,
  },
  {
    key: 'direct',
    type: 'direct',
    id: null,
    label: '直接对话',
    count: props.facets.type_counts.direct,
    selected: isSelected('direct', null),
    disabled: props.facets.type_counts.direct === 0,
    icon: MessageSquare,
  },
]);

const botOptions = computed<SourceOption[]>(() => {
  const typeCount = props.facets.type_counts.bot;
  const specifics = props.facets.origins
    .filter(origin => origin.type === 'bot' && origin.count > 0)
    .map(origin => ({
      key: `bot-${origin.id}`,
      type: 'bot' as const,
      id: origin.id,
      label: origin.display_name,
      count: origin.count,
      selected: isSelected('bot', origin.id),
      indent: true,
      icon: Bot,
    }));

  if (typeCount === 0 && specifics.length === 0) return [];

  return [
    {
      key: 'bot',
      type: 'bot' as const,
      id: null,
      label: '全部 Bot',
      count: typeCount,
      selected: isSelected('bot', null),
      disabled: typeCount === 0,
      icon: Bot,
    },
    ...specifics,
  ];
});

const widgetOptions = computed<SourceOption[]>(() => {
  const typeCount = props.facets.type_counts.widget;
  const specifics = props.facets.origins
    .filter(origin => origin.type === 'widget' && origin.count > 0)
    .map(origin => ({
      key: `widget-${origin.id}`,
      type: 'widget' as const,
      id: origin.id,
      label: origin.display_name,
      count: origin.count,
      selected: isSelected('widget', origin.id),
      indent: true,
      icon: AppWindow,
    }));

  if (typeCount === 0 && specifics.length === 0) return [];

  return [
    {
      key: 'widget',
      type: 'widget' as const,
      id: null,
      label: '全部 Widget',
      count: typeCount,
      selected: isSelected('widget', null),
      disabled: typeCount === 0,
      icon: AppWindow,
    },
    ...specifics,
  ];
});

const allSourceOptions = computed(() => [
  ...dialogueOptions.value,
  ...botOptions.value,
  ...widgetOptions.value,
]);

const selectedOrigin = computed(() => props.facets.origins.find(origin => (
  origin.type === props.filters.originType && origin.id === props.filters.originId
)));
const selectedWorkspace = computed(() => props.facets.workspaces.find(workspace => (
  workspace.workspace_id === props.filters.workspaceId
)));
const selectedSourceKey = computed(() => allSourceOptions.value.find(option => option.selected)?.key || 'all');
const selectedWorkspaceKey = computed(() => props.filters.workspaceId
  ? `workspace:${props.filters.workspaceId}`
  : 'all-workspaces');

const sourceLabel = computed(() => {
  if (selectedOrigin.value) return selectedOrigin.value.display_name;
  if (props.filters.originType === 'direct') return '直接对话';
  if (props.filters.originType === 'bot') return '全部 Bot';
  if (props.filters.originType === 'widget') return '全部 Widget';
  return '全部来源';
});

const workspaceLabel = computed(() => selectedWorkspace.value?.display_name || '全部工作区');

/** 按钮只显示短文案，完整条件放 title / 面板里 */
const triggerLabel = computed(() => {
  if (!hasFilters.value) return '筛选';
  if (activeFilterCount.value === 2) return '已筛选';
  if (hasSourceFilter.value) return sourceLabel.value;
  return workspaceLabel.value;
});

const ariaLabel = computed(() => {
  if (!hasFilters.value) return '筛选会话';
  const parts = [];
  if (hasSourceFilter.value) parts.push(`来源 ${sourceLabel.value}`);
  if (hasWorkspaceFilter.value) parts.push(`工作区 ${workspaceLabel.value}`);
  return `筛选会话：${parts.join('，')}`;
});

function selectSourceKey(key: string) {
  const option = allSourceOptions.value.find(item => item.key === key);
  if (option && !option.disabled) {
    emit('filter', { originType: option.type, originId: option.id });
  }
}

function selectWorkspaceKey(key: string) {
  emit('filter', { workspaceId: key === 'all-workspaces' ? null : key.replace(/^workspace:/, '') });
}

function clearAll() {
  emit('clear');
  open.value = false;
}
</script>

<style scoped>
.session-filter-btn {
  display: inline-flex;
  max-width: 100%;
  min-width: 0;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px 0 7px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--color-text-muted, hsl(var(--muted-foreground)));
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 160ms ease,
    border-color 160ms ease,
    color 160ms ease,
    box-shadow 160ms ease;
}

.session-filter-btn:hover:not(.is-disabled) {
  background: color-mix(in srgb, var(--color-bg-secondary, hsl(var(--secondary))) 88%, transparent);
  color: var(--color-text-primary, hsl(var(--foreground)));
}

.session-filter-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-brand-accent, hsl(var(--ring))) 28%, transparent);
}

.session-filter-btn.is-open:not(.is-disabled) {
  background: color-mix(in srgb, var(--color-bg-secondary, hsl(var(--secondary))) 100%, transparent);
  color: var(--color-text-primary, hsl(var(--foreground)));
}

.session-filter-btn.is-active {
  color: var(--color-text-primary, hsl(var(--foreground)));
  background: color-mix(in srgb, var(--color-brand-accent, hsl(var(--primary))) 10%, transparent);
  border-color: color-mix(in srgb, var(--color-brand-accent, hsl(var(--primary))) 26%, transparent);
}

.session-filter-btn.is-active:hover:not(.is-disabled) {
  background: color-mix(in srgb, var(--color-brand-accent, hsl(var(--primary))) 14%, transparent);
}

.session-filter-btn.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.session-filter-btn.is-compact {
  position: relative;
  width: 28px;
  height: 28px;
  justify-content: center;
  gap: 0;
  padding: 0;
  border-radius: var(--radius-md);
}

.session-filter-btn.is-compact .session-filter-btn__badge {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  font-size: 8px;
}

.session-filter-btn__icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}

.session-filter-btn.is-active .session-filter-btn__icon {
  color: var(--color-brand-accent, hsl(var(--primary)));
}

.session-filter-btn__label {
  min-width: 0;
  max-width: 7.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 550;
}

.session-filter-btn__badge {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-brand-accent, hsl(var(--primary))) 16%, transparent);
  color: var(--color-brand-accent, hsl(var(--primary)));
  font-size: 10px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.session-filter-btn__chevron {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  opacity: 0.55;
  transition: transform 160ms ease, opacity 160ms ease;
}

.session-filter-btn__chevron.is-open {
  transform: rotate(180deg);
  opacity: 0.85;
}

.session-filter-panel {
  display: flex;
  flex-direction: column;
  max-height: min(70vh, 420px);
  overflow: hidden;
}

.session-filter-panel__section {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  overflow-y: auto;
}

.session-filter-panel__heading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px 6px;
  color: var(--color-text-muted, hsl(var(--muted-foreground)));
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.02em;
}

.session-filter-item {
  gap: 0;
}

.session-filter-item__icon {
  width: 14px;
  height: 14px;
  margin-right: 8px;
  flex-shrink: 0;
  color: var(--color-text-muted, hsl(var(--muted-foreground)));
}

.session-filter-item__count {
  margin-left: 8px;
  flex-shrink: 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted, hsl(var(--muted-foreground)));
}

.session-filter-panel__footer {
  display: flex;
  border-top: 1px solid var(--color-border, hsl(var(--border)));
  padding: 6px 8px;
}

.session-filter-clear-all {
  display: inline-flex;
  width: 100%;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-muted, hsl(var(--muted-foreground)));
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}

.session-filter-clear-all:hover {
  background: color-mix(in srgb, var(--color-bg-secondary, hsl(var(--secondary))) 100%, transparent);
  color: var(--color-text-primary, hsl(var(--foreground)));
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .session-filter-btn,
  .session-filter-btn__chevron,
  .session-filter-clear-all {
    transition: none;
  }
}
</style>
