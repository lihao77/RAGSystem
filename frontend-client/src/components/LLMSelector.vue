<template>
  <div class="llm-selector" ref="selectorRef">
    <!-- 选择器按钮 -->
    <div
      ref="triggerRef"
      class="llm-select-trigger"
      :class="{ 'open': dropdownOpen, 'disabled': loading || models.length === 0 }"
      @click="toggleDropdown"
      :title="selectedModel || 'Select LLM Model'"
    >
      <span class="selected-text">{{ displayText }}</span>

      <!-- 箭头图标 -->
      <svg
        class="arrow-icon"
        :class="{ 'rotate': dropdownOpen }"
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>

      <!-- Loading indicator -->
      <div v-if="loading" class="loading-spinner"></div>
    </div>

    <!-- 下拉列表 -->
    <Teleport to="body">
      <transition :name="dropdownTransitionName">
        <div
          v-if="dropdownOpen"
          ref="dropdownRef"
          class="dropdown-menu dropdown-menu--teleported"
          :class="`dropdown-menu--${resolvedPlacement}`"
          :style="dropdownStyle"
        >
          <div ref="dropdownContentRef" class="dropdown-content">
            <!-- 搜索框（可选） -->
            <div v-if="models.length > 5" class="search-box">
              <input
                ref="searchInputRef"
                v-model="searchQuery"
                type="text"
                placeholder="Search models..."
                class="search-input"
                @click.stop
              />
            </div>

            <!-- 选项列表 -->
            <div class="options-list">
              <!-- 默认选项：使用智能体配置 -->
              <div
                class="option-item"
                :class="{ 'selected': selectedModel === '' }"
                @click="selectModel('')"
              >
                <span class="option-label">默认<span class="option-sub">使用智能体配置</span></span>
                <svg
                  v-if="selectedModel === ''"
                  class="check-icon"
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              </div>

              <!-- 分隔线 -->
              <div class="options-divider"></div>

              <!-- 模型选项 -->
              <div
                v-for="model in filteredModels"
                :key="model.value"
                class="option-item"
                :class="{ 'selected': model.value === selectedModel }"
                @click="selectModel(model.value)"
              >
                <span class="option-label">{{ model.label }}</span>
                <svg
                  v-if="model.value === selectedModel"
                  class="check-icon"
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              </div>

              <!-- 无结果提示 -->
              <div v-if="filteredModels.length === 0" class="no-results">
                No models found
              </div>
            </div>
          </div>
        </div>
      </transition>
    </Teleport>

    <!-- Error indicator -->
    <div
      v-if="error"
      class="error-indicator"
      :title="error"
    >
      ⚠️
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { usePointerDownOutside, usePointerInsideRegistry } from '../composables/usePointerDownOutside';
import { useDropdownPosition } from '../composables/useDropdownPosition';
import { getAvailableModels } from '../api/modelAdapter';

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  }
});

const emit = defineEmits(['update:modelValue', 'change']);

const models = ref([]);
const selectedModel = ref(props.modelValue || '');
const loading = ref(false);
const error = ref('');
const dropdownOpen = ref(false);
const searchQuery = ref('');
const selectorRef = ref(null);
const triggerRef = ref(null);
const dropdownRef = ref(null);
const dropdownContentRef = ref(null);
const searchInputRef = ref(null);

// 显示文本
const displayText = computed(() => {
  if (loading.value) return 'Loading...';
  if (models.value.length === 0) return 'No models available';
  if (!selectedModel.value) return '默认';
  const model = models.value.find(m => m.value === selectedModel.value);
  return model ? model.label : selectedModel.value;
});

// 过滤后的模型列表
const filteredModels = computed(() => {
  if (!searchQuery.value) return models.value;
  const query = searchQuery.value.toLowerCase();
  return models.value.filter(m =>
    m.label.toLowerCase().includes(query) ||
    m.provider.toLowerCase().includes(query) ||
    m.model.toLowerCase().includes(query)
  );
});

const {
  resolvedPlacement,
  dropdownStyle,
  dropdownTransitionName,
  updatePosition,
} = useDropdownPosition({
  triggerRef,
  dropdownRef,
  contentRef: dropdownContentRef,
  isOpen: dropdownOpen,
  maxHeight: 360,
  minWidth: 220,
  // padding(8*2) + gap(12) + check-icon(16) + sub-text-margin(6) + scrollbar(6) + item-padding(14*2) ≈ 78
  widthChrome: 78,
  getLabels: () => [
    '默认 使用智能体配置',
    ...filteredModels.value.map(m => m.label ?? m.value ?? ''),
  ],
  fallbackFont: '500 14px sans-serif',
});

// 加载可用模型列表
const loadModels = async () => {
  loading.value = true;
  error.value = '';

  try {
    const availableModels = await getAvailableModels();
    models.value = availableModels;

    // 如果已有保存的选择，恢复它
    const savedModel = localStorage.getItem('selectedLLMModel');
    if (savedModel !== null) {
      if (availableModels.some(m => m.value === savedModel)) {
        selectedModel.value = savedModel;
        emit('update:modelValue', savedModel);
      } else {
        // 保存的值不在列表中，清除它
        localStorage.removeItem('selectedLLMModel');
      }
    }
    // 不自动选择第一个，保持默认状态由 agent 配置决定
  } catch (err) {
    console.error('Failed to load models:', err);
    error.value = 'Failed to load models';
  } finally {
    loading.value = false;
  }
};

const toggleDropdown = async () => {
  if (loading.value || models.value.length === 0) return;
  dropdownOpen.value = !dropdownOpen.value;

  if (dropdownOpen.value) {
    await nextTick();
    updatePosition();
    await nextTick();
    searchInputRef.value?.focus();
  } else {
    searchQuery.value = '';
  }
};

// 选择模型
const selectModel = (value) => {
  selectedModel.value = value;
  emit('update:modelValue', value);
  emit('change', value);

  // 保存用户选择（空值 = 清除记录，恢复默认行为）
  if (value) {
    localStorage.setItem('selectedLLMModel', value);
  } else {
    localStorage.removeItem('selectedLLMModel');
  }

  // 关闭下拉菜单
  dropdownOpen.value = false;
  searchQuery.value = '';
};

usePointerDownOutside({
  inside: [selectorRef, dropdownRef],
  enabled: () => dropdownOpen.value,
  onOutside: () => {
    dropdownOpen.value = false;
    searchQuery.value = '';
  },
});

usePointerInsideRegistry([dropdownRef], () => dropdownOpen.value);

// 键盘导航支持
const handleKeydown = (event) => {
  if (!dropdownOpen.value) return;

  if (event.key === 'Escape') {
    dropdownOpen.value = false;
    searchQuery.value = '';
  }
};

// 监听外部变化
watch(() => props.modelValue, (newValue) => {
  if (newValue !== selectedModel.value) {
    selectedModel.value = newValue;
  }
});

watch(() => [filteredModels.value.length, models.value.length], () => {
  if (dropdownOpen.value) {
    nextTick(updatePosition);
  }
});

onMounted(() => {
  loadModels();
  document.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
});

// 获取当前选择（包含 localStorage 回退）
const getSelection = () => selectedModel.value || localStorage.getItem('selectedLLMModel') || '';

defineExpose({ getSelection });
</script>

<style scoped>
.llm-selector {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* 触发按钮 */
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

.llm-select-trigger:active:not(.disabled) {
  box-shadow: var(--shadow-sm);
}

.llm-select-trigger.open {
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.1);
}

.llm-select-trigger.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 选中文本 */
.selected-text {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 箭头图标 */
.arrow-icon {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  transition: transform 0.3s;
  flex-shrink: 0;
  pointer-events: none;
}

.arrow-icon.rotate {
  transform: translateY(-50%) rotate(180deg);
}

/* Loading spinner */
.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-text-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
}

@keyframes spin {
  to {
    transform: translateY(-50%) rotate(360deg);
  }
}

/* 下拉菜单 */
.dropdown-menu {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  box-sizing: border-box;
}

.dropdown-menu--teleported {
  position: fixed;
  z-index: 9999;
}

.dropdown-menu--up {
  transform-origin: bottom center;
}

.dropdown-menu--down {
  transform-origin: top center;
}

.dropdown-content {
  display: flex;
  flex-direction: column;
  max-height: inherit;
  overflow: hidden;
}

/* 搜索框 */
.search-box {
  padding: 12px;
  border-bottom: 1px solid var(--color-border);
}

.search-input {
  width: 100%;
  height: 40px;
  padding: 0 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  font-size: 13px;
  transition: all 0.3s;
  outline: none;
}

.search-input:focus {
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.1);
}

.search-input::placeholder {
  color: var(--color-text-muted);
}

/* 选项列表 */
.options-list {
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  box-sizing: border-box;
}

.option-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: all 0.3s;
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 500;
  gap: 12px;
}

.option-item:hover {
  background: var(--color-interactive-hover);
  transform: translateX(2px);
}

.option-item.selected {
  background: rgba(var(--color-brand-accent-rgb), 0.12);
  color: var(--color-text-primary);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.option-sub {
  font-size: 11px;
  color: var(--color-text-muted);
  font-weight: 400;
  margin-left: 6px;
}

.options-divider {
  height: 1px;
  background: var(--color-border);
  margin: 4px 8px;
}

.option-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.check-icon {
  flex-shrink: 0;
  color: var(--color-success);
}

/* 无结果 */
.no-results {
  padding: 20px;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 13px;
  font-style: italic;
}

/* 下拉动画（方向感知） */
.dropdown-down-enter-active {
  animation: dropdownDownIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.dropdown-down-leave-active {
  animation: dropdownDownOut 0.15s cubic-bezier(0.4, 0, 1, 1);
}
.dropdown-up-enter-active {
  animation: dropdownUpIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.dropdown-up-leave-active {
  animation: dropdownUpOut 0.15s cubic-bezier(0.4, 0, 1, 1);
}

@keyframes dropdownDownIn {
  from { opacity: 0; transform: translateY(-8px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes dropdownDownOut {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to   { opacity: 0; transform: translateY(-8px) scale(0.96); }
}
@keyframes dropdownUpIn {
  from { opacity: 0; transform: translateY(8px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes dropdownUpOut {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to   { opacity: 0; transform: translateY(8px) scale(0.96); }
}

/* Error indicator */
.error-indicator {
  font-size: 18px;
  cursor: help;
  position: absolute;
  right: -24px;
  top: 50%;
  transform: translateY(-50%);
}

/* 移动端优化 */
@media (max-width: 767px) {
  .llm-select-trigger {
    height: var(--control-height-md);
    min-width: 140px;
    font-size: 12px;
    padding: 0 36px 0 12px;
  }

  .arrow-icon {
    right: 10px;
  }

  .option-item {
    padding: 12px 10px;
    font-size: 13px;
  }

  .search-input {
    font-size: 12px;
    height: 32px;
  }
}

/* 滚动条样式 */
.options-list::-webkit-scrollbar {
  width: 6px;
}

.options-list::-webkit-scrollbar-track {
  background: transparent;
}

.options-list::-webkit-scrollbar-thumb {
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-full);
}

.options-list::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-muted);
}
</style>
