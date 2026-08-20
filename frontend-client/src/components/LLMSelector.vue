<template>
  <div class="llm-selector" :class="{ 'llm-selector--composer': presentation === 'composer' }">
    <DropdownMenu v-model:open="open">
      <DropdownMenuTrigger as-child>
        <button
          type="button"
          class="llm-select-trigger"
          :class="{ open, disabled: loading || models.length === 0 }"
          :disabled="loading || models.length === 0"
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
        <DropdownMenuItem class="llm-option" @select="selectModel('')">
          <span class="option-copy">
            <span class="option-label">默认</span>
            <span class="option-sub">使用智能体配置</span>
          </span>
          <IconCheck v-if="!selectedModel" class="check-icon" :size="16" :stroke-width="2.5" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <!-- 点击 provider 行 = 选该 provider 的默认（首个）模型；hover 展开子菜单选具体模型 -->
        <DropdownMenuSub v-for="group in providerGroups" :key="group.key">
          <DropdownMenuSubTrigger class="llm-option llm-provider" @click="selectProviderDefault(group)">
            <span class="option-label">{{ group.label }}</span>
            <IconCheck v-if="group.selected" class="check-icon" :size="14" :stroke-width="2.5" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="llm-submenu">
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
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>

    <div v-if="error" class="error-indicator" :title="error"><IconWarning :size="16" /></div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { findProviderModelByValue, getAvailableModels } from '../api/modelAdapter';
import { useLlmStore } from '../stores/llm.js';
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

const models = ref([]);
const loading = ref(false);
const error = ref('');
const open = ref(false);

// 按 provider 分组（保持接口返回顺序）；组内首个模型即该 provider 的默认模型
// （collectProviderModels 以 model_map 的 chat 任务列表开头，顺序即用户配置的优先级）。
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
  if (models.value.length === 0) return '无可用模型';
  if (!selectedModel.value) return '默认';
  const model = models.value.find(m => m.value === selectedModel.value);
  return model?.model || findProviderModelByValue(selectedModel.value).model || selectedModel.value;
});

const selectedModelTitle = computed(() => {
  if (!selectedModel.value) return '默认模型（使用智能体配置）';
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

const loadModels = async () => {
  loading.value = true;
  error.value = '';
  try {
    const availableModels = await getAvailableModels();
    models.value = availableModels;
    // store 已持有保存的选择（构造时从 localStorage 恢复）；若不在可用列表则清除
    const savedModel = selectedModel.value;
    if (savedModel && !availableModels.some(m => m.value === savedModel)) {
      llmStore.setSelectedLLM('');
    }
    // 不自动选择第一个，保持默认状态由 agent 配置决定
  } catch (err) {
    console.error('Failed to load models:', err);
    error.value = 'Failed to load models';
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  loadModels();
});

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

/* 触发按钮（pill） */
.llm-select-trigger {
  height: var(--control-height-md);
  min-width: 180px;
  padding: 0 44px 0 18px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-primary);
  font-size: 13px;
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
  border-color: var(--color-border-focus);
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
  font-size: 14px;
  font-weight: 500;
  gap: 12px;
  cursor: pointer;
}

.llm-provider {
  font-size: 13px;
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
  font-size: 11px;
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
  font-size: 10px;
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
    font-size: 12px;
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
