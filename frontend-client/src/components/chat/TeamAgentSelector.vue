<template>
  <DropdownMenu v-model:open="menuOpen">
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        class="ta-trigger"
        :class="{ open: menuOpen, disabled: disabled }"
        :disabled="disabled"
        :title="displayText"
      >
        <span class="selected-text">{{ displayText }}</span>
        <IconChevronDown class="arrow-icon" :class="{ rotate: menuOpen }" :size="14" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent class="ta-menu" align="start" side="top" :side-offset="8">
      <DropdownMenuSub
        v-for="t in teamOptions"
        :key="t.value"
        @update:open="(open) => open && ensureTeamAgents(t.value)"
      >
        <!-- 点击 team 行 = 选该 team 及其默认入口 Agent；hover 展开子菜单可另选 Agent -->
        <DropdownMenuSubTrigger class="ta-team" @click="selectTeam(t.value)">
          <span class="ta-team-label">{{ t.value }}</span>
          <span v-if="t.isActive" class="ta-tag">默认</span>
          <IconCheck v-if="t.value === team" :size="14" class="ta-check" />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="ta-submenu">
          <DropdownMenuItem v-if="teamState(t.value).loading" disabled>加载 Agent…</DropdownMenuItem>
          <template v-else-if="teamState(t.value).items.length">
            <DropdownMenuItem
              v-for="agent in teamState(t.value).items"
              :key="agent.value"
              class="ta-agent"
              @select="selectAgent(t.value, agent.value)"
            >
              <span class="ta-agent-label">{{ agent.label }}</span>
              <span v-if="agent.defaultEntry" class="ta-tag">默认</span>
              <IconCheck v-if="t.value === team && agent.value === resolvedAgent" :size="14" class="ta-check" />
            </DropdownMenuItem>
          </template>
          <DropdownMenuItem v-else disabled>无可用 Agent</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem v-if="!teamOptions.length" disabled>暂无 Team</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { useDictionariesStore } from '../../stores/dictionaries.js';
import IconCheck from '../icons/IconCheck.vue';
import IconChevronDown from '../icons/IconChevronDown.vue';

const props = defineProps({
  team: { type: String, default: '' },
  teamOptions: { type: Array, default: () => [] },
  teamLoading: { type: Boolean, default: false },
  entryAgent: { type: String, default: '' },
});

const emit = defineEmits(['update:selection']);

const dictStore = useDictionariesStore();
const menuOpen = ref(false);
// team -> { loading, loaded, items:[{value,label,defaultEntry}] }；数据本身由 dictStore 按 team 缓存，
// 这里只维护展示态，菜单打开时强制刷新一轮以跟上配置变更。
const agentsState = reactive({});

const teamState = (team) => agentsState[team] || { loading: false, items: [] };

const ensureTeamAgents = async (team) => {
  const name = (team || '').trim();
  if (!name) return;
  const state = agentsState[name] || (agentsState[name] = { loading: false, loaded: false, items: [] });
  if (state.loading) return;
  state.loading = true;
  try {
    const configs = await dictStore.ensureAgents(false, name);
    state.items = Object.values(configs || {})
      .filter(config => config && config.enabled)
      .map(config => ({
        value: config.agent_name,
        label: config.display_name || config.agent_name,
        defaultEntry: Boolean(config.default_entry),
      }));
    state.loaded = true;
  } catch (error) {
    console.warn('加载 Team Agent 列表失败:', error);
    state.items = [];
  } finally {
    state.loading = false;
  }
};

// 未显式指定 Agent 时，实际生效的是 team 的默认入口 Agent
const resolvedAgent = computed(() => {
  if (props.entryAgent) return props.entryAgent;
  return teamState(props.team).items.find(item => item.defaultEntry)?.value || '';
});

const agentLabel = (items, value) => items.find(item => item.value === value)?.label || value;

const displayText = computed(() => {
  if (props.teamLoading) return '加载 Team…';
  const team = props.team.trim();
  if (!team) return '选择 Team / Agent';
  const items = teamState(team).items;
  if (props.entryAgent) return `${team} / ${agentLabel(items, props.entryAgent)}`;
  const defaultEntry = items.find(item => item.defaultEntry);
  return `${team} / ${defaultEntry ? defaultEntry.label : '默认 Agent'}`;
});

const disabled = computed(() => props.teamLoading || props.teamOptions.length === 0);

const selectTeam = (team) => {
  emit('update:selection', { team, entryAgent: '' });
  menuOpen.value = false;
};

const selectAgent = (team, entryAgent) => {
  emit('update:selection', { team, entryAgent });
  menuOpen.value = false;
};

watch(menuOpen, (open) => {
  if (!open) return;
  // 预取全部 team 的 Agent，保证 hover 子菜单即开即有
  props.teamOptions.forEach(t => { void ensureTeamAgents(t.value); });
});

// 触发器文案依赖当前 team 的 Agent 列表
watch(() => props.team, (team) => { void ensureTeamAgents(team); }, { immediate: true });
</script>

<style scoped>
.ta-trigger {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: auto;
  min-width: 0;
  max-width: 200px;
  height: 28px;
  padding: 0 30px 0 10px;
  border: 1px solid transparent;
  border-radius: var(--control-radius);
  background: transparent;
  box-shadow: none;
  color: var(--color-text-primary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0;
  cursor: pointer;
  user-select: none;
  transition: all 0.3s;
}

.ta-trigger:hover:not(.disabled) {
  border-color: transparent;
  background: var(--color-hover-overlay);
}

.ta-trigger.open {
  border-color: var(--color-border-focus);
  background: var(--color-hover-overlay);
}

.ta-trigger.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.selected-text {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
}

.arrow-icon {
  position: absolute;
  right: 9px;
  top: 50%;
  transform: translateY(-50%);
  transition: transform 0.3s;
  flex-shrink: 0;
  pointer-events: none;
  color: var(--color-text-secondary);
}

.arrow-icon.rotate {
  transform: translateY(-50%) rotate(180deg);
}

.ta-menu {
  min-width: 200px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-lg);
}

.ta-submenu {
  min-width: 180px;
  max-height: 320px;
  overflow-y: auto;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-lg);
}

.ta-team,
.ta-agent {
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 500;
  gap: 8px;
  cursor: pointer;
}

.ta-team-label,
.ta-agent-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ta-tag {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(var(--color-brand-accent-rgb), 0.14);
  color: var(--color-brand-accent-light);
  font-size: 10px;
  font-weight: 500;
  line-height: 16px;
}

.ta-check {
  flex-shrink: 0;
  color: var(--color-success);
}

@media (max-width: 767px) {
  .ta-trigger {
    max-width: 140px;
    padding-left: 8px;
  }
}
</style>
