<template>
  <div class="llm-selector">
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <button
          type="button"
          class="llm-select-trigger"
          :class="{ open, disabled: loading || models.length === 0 }"
          :disabled="loading || models.length === 0"
          :title="selectedModel || 'Select LLM Model'"
          role="combobox"
          :aria-expanded="open"
        >
          <span class="selected-text">{{ displayText }}</span>
          <IconChevronDown class="arrow-icon" :class="{ rotate: open }" :size="16" />
          <div v-if="loading" class="loading-spinner"></div>
        </button>
      </PopoverTrigger>
      <PopoverContent class="llm-popover" align="start" :side-offset="8">
        <Command>
          <CommandInput v-if="models.length > 5" placeholder="Search models..." />
          <CommandList>
            <CommandEmpty>No models found</CommandEmpty>
            <CommandGroup>
              <CommandItem class="llm-option" value="__default__" @select="() => selectModel('')">
                <span class="option-label">默认<span class="option-sub">使用智能体配置</span></span>
                <IconCheck v-if="!selectedModel" class="check-icon" :size="16" :stroke-width="2.5" />
              </CommandItem>
              <CommandSeparator />
              <CommandItem
                v-for="m in models"
                :key="m.value"
                class="llm-option"
                :value="m.value"
                @select="() => selectModel(m.value)"
              >
                <span class="option-label">{{ m.label }}</span>
                <span class="sr-only">{{ m.provider }} {{ m.model }}</span>
                <IconCheck v-if="m.value === selectedModel" class="check-icon" :size="16" :stroke-width="2.5" />
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>

    <div v-if="error" class="error-indicator" :title="error">⚠️</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandSeparator } from './ui/command';
import { getAvailableModels } from '../api/modelAdapter';
import { useLlmStore } from '../stores/llm.js';
import IconChevronDown from './icons/IconChevronDown.vue';
import IconCheck from './icons/IconCheck.vue';

const llmStore = useLlmStore();
const { selectedLLM: selectedModel } = storeToRefs(llmStore);

const models = ref([]);
const loading = ref(false);
const error = ref('');
const open = ref(false);

const displayText = computed(() => {
  if (loading.value) return 'Loading...';
  if (models.value.length === 0) return 'No models available';
  if (!selectedModel.value) return '默认';
  const model = models.value.find(m => m.value === selectedModel.value);
  return model ? model.label : selectedModel.value;
});

const selectModel = (value) => {
  llmStore.setSelectedLLM(value);
  open.value = false;
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

/* Popover 内容 */
.llm-popover {
  width: 280px;
  padding: 0;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-lg);
}

/* Command 选项 */
.llm-option {
  padding: 10px 14px !important;
  border-radius: var(--radius-md) !important;
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.llm-option[data-highlighted] {
  background: var(--color-interactive-hover) !important;
}

.option-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.option-sub {
  font-size: 11px;
  color: var(--color-text-muted);
  font-weight: 400;
  margin-left: 6px;
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
  font-size: 18px;
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
}
</style>
