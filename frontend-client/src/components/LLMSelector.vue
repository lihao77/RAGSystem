<template>
  <div class="llm-selector" :class="{ 'llm-selector--composer': presentation === 'composer' }">
    <DropdownMenu v-model:open="open">
      <DropdownMenuTrigger as-child>
        <button
          type="button"
          class="llm-select-trigger"
          :class="{ open, disabled: loading }"
          :disabled="loading"
          :title="selectedModelTitle"
          role="combobox"
          :aria-expanded="open"
        >
          <span class="selected-text">{{ displayText }}</span>
          <IconChevronDown class="arrow-icon" :class="{ rotate: open }" :size="14" />
          <div v-if="loading" class="loading-spinner"></div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        class="llm-menu"
        align="start"
        :side="presentation === 'composer' ? 'top' : 'bottom'"
        :side-offset="8"
      >
        <Alert v-if="hasDefaultFallback" class="mb-2 max-w-72" role="status">
          <AlertTitle>已回落系统模型</AlertTitle>
          <AlertDescription>
            {{ fallbackDescription }}
          </AlertDescription>
        </Alert>
        <DropdownMenuGroup>
          <DropdownMenuItem class="llm-option" @select="selectModel('')">
            <span class="option-copy">
              <span class="option-label">默认</span>
              <span class="option-sub" :title="defaultModelDescription">{{ defaultModelDescription }}</span>
            </span>
            <IconCheck v-if="!selectedModel" class="check-icon" :size="16" :stroke-width="2.5" />
          </DropdownMenuItem>
          <DropdownMenuItem v-if="hasDefaultFallback && hasTenantRole('admin')" as-child>
            <RouterLink to="/agent-studio">检查 Agent 配置</RouterLink>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <!-- 点击 provider 行 = 选该 provider 的默认（首个）模型；hover 展开子菜单选具体模型 -->
        <DropdownMenuSub v-for="group in providerGroups" :key="group.key">
          <DropdownMenuSubTrigger class="llm-option llm-provider" @click="selectProviderDefault(group)">
            <span class="option-label">{{ group.label }}</span>
            <IconCheck v-if="group.selected" class="check-icon" :size="14" :stroke-width="2.5" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="llm-submenu">
            <DropdownMenuGroup>
              <DropdownMenuItem
                v-for="(m, i) in group.models"
                :key="m.value"
                class="llm-option"
                @select="selectModel(m.value)"
              >
                <span class="option-label">{{ m.model }}</span>
                <span v-if="i === 0" class="default-tag">默认</span>
                <IconCheck v-if="m.value === selectedModel" class="check-icon" :size="16" :stroke-width="2.5" />
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>

    <button v-if="hasDefaultFallback" type="button" class="llm-fallback-indicator" :title="fallbackDescription" :aria-label="fallbackDescription" @click="open = !open">
      <IconWarning :size="14" aria-hidden="true" />
    </button>
    <div v-if="error" class="error-indicator" :title="error"><IconWarning :size="16" /></div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onScopeDispose, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { storeToRefs } from 'pinia';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { findProviderModelByValue, getAvailableModels } from '../api/modelAdapter';
import { useLlmStore } from '../stores/llm.js';
import { useSessionRunStore } from '../stores/session-run.js';
import { useDefaultLlm } from '../composables/useDefaultLlm.js';
import { usePermission } from '../composables/usePermission.js';
import { defaultLlmRevision } from '../api/runtimeCore.js';
import { Alert, AlertTitle, AlertDescription } from './ui/alert';
import IconChevronDown from './icons/IconChevronDown.vue';
import IconCheck from './icons/IconCheck.vue';
import IconWarning from './icons/IconWarning.vue';

defineProps({
  presentation: {
    type: String,
    default: 'toolbar',
    validator: value => ['toolbar', 'composer'].includes(value),
  },
});

const llmStore = useLlmStore();
const { selectedLLM: selectedModel } = storeToRefs(llmStore);
const { currentSessionTeam, pendingEntryAgent } = storeToRefs(useSessionRunStore());
const { llm: defaultLlm, loading: defaultLoading, refresh: refreshDefaultLlm } = useDefaultLlm(currentSessionTeam, pendingEntryAgent);
const { hasTenantRole } = usePermission();

const models = ref([]);
const loading = ref(false);
const error = ref('');
const open = ref(false);
const defaultModelDescription = computed(() => {
  if (defaultLoading.value) return '正在解析默认模型…';
  if (!defaultLlm.value) return '默认模型暂不可用，打开菜单可重试';
  const { model, provider, source } = defaultLlm.value;
  return `${model} · ${provider} · ${source === 'system_config.llm' ? '系统配置' : '智能体配置'}`;
});
const hasDefaultFallback = computed(() => !selectedModel.value && defaultLlm.value?.fallback_reason === 'agent_default_tier_unresolved');
const fallbackDescription = computed(() => `Agent 默认档引用失效，已使用系统模型 ${defaultLlm.value?.model || ''}（${defaultLlm.value?.provider || ''}）。`);

// 按 provider 分组（保持接口返回顺序）；组内首个模型即该 provider 的默认模型
// （models 数组序即用户配置的优先级，首个为默认）。
const providerGroups = computed(() => {
  const groups = [];
  const byKey = new Map();
  for (const m of models.value) {
    const key = `${m.provider}|${m.provider_type}`;
    if (!byKey.has(key)) {
      const group = {
        key,
        label: m.provider + (m.provider_type ? ` (${m.provider_type})` : ''),
        models: [],
        selected: false,
      };
      byKey.set(key, group);
      groups.push(group);
    }
    const group = byKey.get(key);
    group.models.push(m);
    if (m.value === selectedModel.value) group.selected = true;
  }
  return groups;
});

const displayText = computed(() => {
  if (loading.value) return '加载中';
  if (!selectedModel.value) return defaultLlm.value ? `默认 · ${defaultLlm.value.model}` : '默认';
  if (models.value.length === 0) return '无可用模型';
  const model = models.value.find(m => m.value === selectedModel.value);
  return model?.model || findProviderModelByValue(selectedModel.value).model || selectedModel.value;
});

const selectedModelTitle = computed(() => {
  if (!selectedModel.value) return hasDefaultFallback.value ? fallbackDescription.value : `默认模型：${defaultModelDescription.value}`;
  const model = models.value.find(item => item.value === selectedModel.value);
  if (model) return `${model.model} · ${model.provider}`;
  const parsed = findProviderModelByValue(selectedModel.value);
  return [parsed.model, parsed.provider].filter(Boolean).join(' · ') || selectedModel.value;
});

const selectModel = (value) => {
  llmStore.setSelectedLLM(value);
  open.value = false;
};

const selectProviderDefault = (group) => {
  if (!group.models.length) return;
  selectModel(group.models[0].value);
};

let modelsLoadSequence = 0;
const loadModels = async () => {
  const sequence = ++modelsLoadSequence;
  loading.value = true;
  error.value = '';
  try {
    const availableModels = await getAvailableModels();
    if (sequence !== modelsLoadSequence) return;
    models.value = availableModels;
    // store 已持有保存的选择（构造时从 localStorage 恢复 / 会话恢复覆盖层）；
    // 失效时先清会话覆盖（恢复值对应的模型已下线），回落后的个人默认也失效才清全局。
    // 走 discardStaleDefault 而非 setSelectedLLM：自动清理不是用户选择，
    // 不得触发"选择即落库"把会话恢复记录抹成默认。
    const invalidateIfStale = () => {
      const current = selectedModel.value;
      if (!current || models.value.some(m => m.value === current)) return;
      llmStore.clearSessionOverride();
      const fallback = selectedModel.value;
      if (fallback && !models.value.some(m => m.value === fallback)) {
        llmStore.discardStaleDefault();
      }
    };
    invalidateIfStale();
    // 不自动选择第一个，保持默认状态由 agent 配置决定
  } catch (err) {
    if (sequence !== modelsLoadSequence) return;
    console.error('Failed to load models:', err);
    error.value = 'Failed to load models';
  } finally {
    if (sequence === modelsLoadSequence) loading.value = false;
  }
};

onMounted(() => {
  loadModels();
});
watch(defaultLlmRevision, loadModels);
watch(open, (isOpen) => { if (isOpen) refreshDefaultLlm(); });
onScopeDispose(() => { modelsLoadSequence += 1; });

// 获取当前选择（store 单源）
const getSelection = () => selectedModel.value;

defineExpose({ getSelection });
</script>

<style scoped>
.llm-selector {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.llm-fallback-indicator {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  padding: 4px;
  color: var(--color-warning);
  border-radius: var(--control-radius);
}
.llm-fallback-indicator:focus-visible {
  outline: 2px solid var(--color-border-focus);
}

/* 触发按钮（pill） */
.llm-select-trigger {
  height: var(--control-height-md);
  min-width: 180px;
  padding: 0 44px 0 18px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 600;
  letter-spacing: 0;
  cursor: pointer;
  transition: all 0.3s;
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
  user-select: none;
  box-shadow: var(--shadow-sm);
  /* 覆盖 shadcn Trigger 带来的 tailwind outline-none（=2px solid transparent）。
     outline 样式保持 none：配合 transition:all，若样式为 solid，焦点进出时
     outline 颜色补间会在按钮周围产生一圈渐隐的白色轮廓（点击闪现） */
  outline: none;
}
.llm-select-trigger:focus-visible {
  border-color: var(--color-border-focus);
}
.llm-select-trigger:hover:not(.disabled) {
  background-color: var(--color-interactive-hover);
  border-color: var(--color-border-hover);
  box-shadow: var(--shadow-md);
}
.llm-select-trigger.open {
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.1);
}
.llm-select-trigger.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.llm-selector--composer .llm-select-trigger {
  width: auto;
  min-width: 0;
  max-width: 160px;
  height: 28px;
  padding: 0 30px 0 10px;
  border-color: transparent;
  border-radius: var(--control-radius);
  background: transparent;
  box-shadow: none;
  font-size: var(--font-size-xs);
}

.llm-selector--composer .llm-select-trigger:hover:not(.disabled) {
  border-color: transparent;
  background: var(--color-hover-overlay);
  box-shadow: none;
}

.llm-selector--composer .llm-select-trigger.open {
  background: var(--color-hover-overlay);
}

/* 聚焦指示改用与 hover 一致的背景；避免点击瞬间轮廓/光圈闪现 */
.llm-selector--composer .llm-select-trigger:focus-visible {
  outline: none;
  box-shadow: none;
  background: var(--color-hover-overlay);
}

.llm-selector--composer .arrow-icon,
.llm-selector--composer .loading-spinner {
  right: 9px;
}

.selected-text {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
}

.arrow-icon {
  position: absolute;
  right: 12px;
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

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-text-primary);
  border-radius: 50%;
  animation: llm-spin 1s linear infinite;
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
}
@keyframes llm-spin {
  to { transform: translateY(-50%) rotate(360deg); }
}

/* 菜单 */
.llm-menu {
  min-width: 240px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-lg);
}

.llm-submenu {
  min-width: 200px;
  max-height: 320px;
  overflow-y: auto;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-lg);
}

.llm-option {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 500;
  gap: 12px;
  cursor: pointer;
}

.llm-provider {
  font-size: var(--font-size-sm);
}

.option-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.option-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.option-sub {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.default-tag {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(var(--color-brand-accent-rgb), 0.14);
  color: var(--color-brand-accent-light);
  font-size: var(--font-size-2xs);
  font-weight: 500;
  line-height: 16px;
}
.check-icon {
  flex-shrink: 0;
  color: var(--color-success);
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

.error-indicator {
  display: flex;
  align-items: center;
  color: var(--color-error, var(--color-warning, #d97706));
  cursor: help;
  position: absolute;
  right: -24px;
  top: 50%;
  transform: translateY(-50%);
}

@media (max-width: 767px) {
  .llm-select-trigger {
    min-width: 140px;
    font-size: var(--font-size-xs);
    padding: 0 36px 0 12px;
  }
  .arrow-icon {
    right: 10px;
  }

  .llm-selector--composer .llm-select-trigger {
    min-width: 0;
    max-width: 132px;
    padding-left: 8px;
  }
}
</style>
