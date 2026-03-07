<template>
  <div class="llm-selector" ref="selectorRef">
    <!-- 选择器按钮 -->
    <div
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
    <transition name="dropdown">
      <div v-if="dropdownOpen" class="dropdown-menu">
        <div class="dropdown-content">
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
const searchInputRef = ref(null);

// 显示文本
const displayText = computed(() => {
  if (loading.value) return 'Loading...';
  if (models.value.length === 0) return 'No models available';
  if (!selectedModel.value) return 'Select Model';
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

// 加载可用模型列表
const loadModels = async () => {
  loading.value = true;
  error.value = '';

  try {
    const availableModels = await getAvailableModels();
    models.value = availableModels;

    // 如果有保存的模型选择，恢复它
    const savedModel = localStorage.getItem('selectedLLMModel');
    if (savedModel && availableModels.some(m => m.value === savedModel)) {
      selectedModel.value = savedModel;
      emit('update:modelValue', savedModel);
    } else if (availableModels.length > 0 && !selectedModel.value) {
      // 默认选择第一个
      selectedModel.value = availableModels[0].value;
      emit('update:modelValue', availableModels[0].value);
      localStorage.setItem('selectedLLMModel', availableModels[0].value);
    }
  } catch (err) {
    console.error('Failed to load models:', err);
    error.value = 'Failed to load models';
  } finally {
    loading.value = false;
  }
};

// 切换下拉菜单
const toggleDropdown = () => {
  if (loading.value || models.value.length === 0) return;
  dropdownOpen.value = !dropdownOpen.value;

  if (dropdownOpen.value) {
    // 聚焦搜索框
    nextTick(() => {
      if (searchInputRef.value) {
        searchInputRef.value.focus();
      }
    });
  } else {
    // 清空搜索
    searchQuery.value = '';
  }
};

// 选择模型
const selectModel = (value) => {
  selectedModel.value = value;
  emit('update:modelValue', value);
  emit('change', value);

  // 保存用户选择
  localStorage.setItem('selectedLLMModel', value);

  // 关闭下拉菜单
  dropdownOpen.value = false;
  searchQuery.value = '';
};

// 点击外部关闭下拉菜单
const handleClickOutside = (event) => {
  if (selectorRef.value && !selectorRef.value.contains(event.target)) {
    dropdownOpen.value = false;
    searchQuery.value = '';
  }
};

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

onMounted(() => {
  loadModels();
  document.addEventListener('click', handleClickOutside);
  document.addEventListener('keydown', handleKeydown);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleKeydown);
});
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
  height: 40px;
  min-width: 180px;
  padding: 0 40px 0 16px;
  border-radius: 20px;
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all var(--transition-normal);
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
  user-select: none;
}

.llm-select-trigger:hover:not(.disabled) {
  background-color: var(--color-interactive-hover);
  border-color: var(--color-border-hover);
}

.llm-select-trigger.open {
  border-color: var(--color-border-focus);
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
  transition: transform var(--transition-normal);
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
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  right: 0;
  min-width: 220px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  z-index: var(--z-overlay);
  overflow: hidden;
}

.dropdown-content {
  display: flex;
  flex-direction: column;
}

/* 搜索框 */
.search-box {
  padding: 12px;
  border-bottom: 1px solid var(--color-border);
}

.search-input {
  width: 100%;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  font-size: 13px;
  transition: all var(--transition-fast);
  outline: none;
}

.search-input:focus {
  border-color: var(--color-border-focus);
}

.search-input::placeholder {
  color: var(--color-text-muted);
}

/* 选项列表 */
.options-list {
  max-height: 280px;
  overflow-y: auto;
  padding: 8px;
}

.option-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 500;
  gap: 12px;
}

.option-item:hover {
  background: var(--color-interactive-hover);
}

.option-item.selected {
  background: rgba(var(--color-brand-accent-rgb), 0.1);
  color: var(--color-text-primary);
  font-weight: 600;
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

/* 下拉动画 */
.dropdown-enter-active {
  animation: dropdownIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.dropdown-leave-active {
  animation: dropdownOut 0.15s cubic-bezier(0.4, 0, 1, 1);
}

@keyframes dropdownIn {
  from {
    opacity: 0;
    transform: translateY(-8px) scale(0.96);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes dropdownOut {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(-8px) scale(0.96);
  }
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
    height: 40px;
    min-width: 140px;
    font-size: 12px;
    padding: 0 36px 0 12px;
  }

  .arrow-icon {
    right: 10px;
  }

  .dropdown-menu {
    min-width: 200px;
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
