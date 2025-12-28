<template>
  <div class="file-selector">
    <!-- 单选模式 -->
    <div v-if="!multiple" class="single-select">
      <el-input
        :model-value="displayValue"
        :placeholder="placeholder || '点击选择文件'"
        :disabled="disabled"
        readonly
        @click="openDialog"
      >
        <template #append>
          <el-button :icon="FolderOpened" @click="openDialog" :disabled="disabled" />
        </template>
      </el-input>
    </div>

    <!-- 多选模式 -->
    <div v-else class="multiple-select">
      <div class="file-list-container">
        <div v-if="selectedFiles.length === 0" class="empty-state">
          <el-icon class="empty-icon"><Document /></el-icon>
          <span class="empty-text">{{ placeholder || '未选择文件' }}</span>
        </div>
        <div v-else class="selected-files-list">
          <div 
            v-for="file in selectedFiles" 
            :key="file.id" 
            class="file-item"
          >
            <el-icon class="file-icon"><Document /></el-icon>
            <span class="file-name">{{ file.original_name }}</span>
            <span class="file-size">{{ formatFileSize(file.size) }}</span>
            <el-button
              :icon="Close"
              circle
              size="small"
              text
              @click="removeFile(file.id)"
              :disabled="disabled"
              class="remove-btn"
            />
          </div>
        </div>
      </div>
      <el-button
        :icon="FolderOpened"
        @click="openDialog"
        :disabled="disabled"
        size="small"
        type="primary"
        style="width: 100%; margin-top: 8px"
      >
        {{ selectedFiles.length > 0 ? `已选择 ${selectedFiles.length} 个文件，点击添加更多` : '选择文件' }}
      </el-button>
    </div>

    <!-- 文件选择对话框 -->
    <el-dialog
      v-model="dialogVisible"
      title="选择文件"
      width="700px"
      :close-on-click-modal="false"
      append-to-body
      modal-class="file-selector-modal"
    >
      <!-- 活动过滤器提示 -->
      <div v-if="hasActiveFilters" class="filter-info">
        <el-alert
          type="info"
          :closable="false"
          show-icon
        >
          <template #title>
            <span>支持的文件类型: </span>
            <span v-if="parsedAccept.extensions">
              {{ parsedAccept.extensions.join(', ') }}
            </span>
            <span v-if="parsedAccept.mimeTypes" style="margin-left: 8px">
              MIME: {{ parsedAccept.mimeTypes.join(', ') }}
            </span>
          </template>
        </el-alert>
      </div>

      <!-- 搜索框 -->
      <el-input
        v-model="searchQuery"
        placeholder="搜索文件名..."
        :prefix-icon="Search"
        clearable
        style="margin-bottom: 16px; margin-top: 16px"
      />

      <!-- 文件列表 -->
      <div v-loading="loading" class="file-list">
        <el-empty v-if="filteredFiles.length === 0" description="没有找到符合条件的文件" />

        <el-table
          v-else
          ref="fileTableRef"
          :data="filteredFiles"
          :height="400"
          @selection-change="handleSelectionChange"
          @row-click="handleRowClick"
        >
          <el-table-column
            v-if="multiple"
            type="selection"
            width="55"
          />

          <el-table-column
            v-else
            width="55"
          >
            <template #default="scope">
              <input
                type="radio"
                :checked="selectedIds.has(scope.row.id)"
                @change="selectSingleFile(scope.row)"
                style="cursor: pointer;"
              />
            </template>
          </el-table-column>

          <el-table-column prop="original_name" label="文件名" min-width="200" />

          <el-table-column prop="size" label="大小" width="100">
            <template #default="scope">
              {{ formatFileSize(scope.row.size) }}
            </template>
          </el-table-column>

          <el-table-column prop="mime" label="类型" width="150" show-overflow-tooltip />

          <el-table-column prop="upload_time" label="上传时间" width="160">
            <template #default="scope">
              {{ formatDate(scope.row.upload_time) }}
            </template>
          </el-table-column>
        </el-table>
      </div>

      <template #footer>
        <el-button @click="cancelSelection">取消</el-button>
        <el-button type="primary" @click="confirmSelection">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { ElMessage } from 'element-plus';
import { FolderOpened, Search, Document, Close } from '@element-plus/icons-vue';
import { listFiles } from '@/api/fileService';

const props = defineProps({
  modelValue: {
    type: [String, Array],
    default: () => null
  },
  multiple: {
    type: Boolean,
    default: false
  },
  accept: {
    type: String,
    default: ''  // 例如: ".txt,.docx,.pdf" 或 "text/plain,application/pdf"
  },
  placeholder: {
    type: String,
    default: ''
  },
  disabled: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['update:modelValue', 'change']);

const dialogVisible = ref(false);
const loading = ref(false);
const files = ref([]);
const selectedIds = ref(new Set());
const searchQuery = ref('');
const initialValue = ref(null);
const fileTableRef = ref(null);

// 计算属性：已选择的文件对象
const selectedFiles = computed(() => {
  if (!props.multiple) {
    const file = files.value.find(f => f.id === props.modelValue);
    return file ? [file] : [];
  } else {
    const ids = Array.isArray(props.modelValue) ? props.modelValue : [];
    return files.value.filter(f => ids.includes(f.id));
  }
});

// 计算属性：显示值（单选模式）
const displayValue = computed(() => {
  if (!props.modelValue) return '';
  const file = files.value.find(f => f.id === props.modelValue);
  return file ? file.original_name : props.modelValue;
});

// 计算属性：解析 accept 属性
const parsedAccept = computed(() => {
  if (!props.accept) return { extensions: null, mimeTypes: null };

  const parts = props.accept.split(',').map(p => p.trim());
  const extensions = [];
  const mimeTypes = [];

  parts.forEach(part => {
    if (part.startsWith('.')) {
      // 文件扩展名
      extensions.push(part.toLowerCase());
    } else if (part.includes('/')) {
      // MIME 类型
      mimeTypes.push(part.toLowerCase());
    }
  });

  return {
    extensions: extensions.length > 0 ? extensions : null,
    mimeTypes: mimeTypes.length > 0 ? mimeTypes : null
  };
});

// 计算属性：是否有活动过滤器
const hasActiveFilters = computed(() => {
  const extensions = props.fileExtensions || parsedAccept.value.extensions;
  const mimeTypes = props.mimeTypes || parsedAccept.value.mimeTypes;
  return (extensions && extensions.length > 0) ||
         (mimeTypes && mimeTypes.length > 0);
});

// 计算属性：过滤后的文件列表
const filteredFiles = computed(() => {
  let result = files.value;

  // 获取扩展名和MIME类型（优先使用 props，其次使用解析的 accept）
  const extensions = props.fileExtensions || parsedAccept.value.extensions;
  const mimeTypes = props.mimeTypes || parsedAccept.value.mimeTypes;

  // 应用扩展名过滤
  if (extensions && extensions.length > 0) {
    const extList = extensions.map(ext => ext.toLowerCase());
    result = result.filter(file => {
      const fileName = file.original_name.toLowerCase();
      return extList.some(ext => fileName.endsWith(ext));
    });
  }

  // 应用MIME类型过滤
  if (mimeTypes && mimeTypes.length > 0) {
    const mimeList = mimeTypes.map(mime => mime.toLowerCase());
    result = result.filter(file => {
      const fileMime = (file.mime || '').toLowerCase();
      return mimeList.includes(fileMime);
    });
  }

  // 应用搜索查询
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    result = result.filter(file =>
      file.original_name.toLowerCase().includes(query)
    );
  }

  return result;
});

// 打开对话框
function openDialog() {
  if (props.disabled) return;
  
  // 保存初始值用于取消操作
  initialValue.value = props.multiple 
    ? [...(Array.isArray(props.modelValue) ? props.modelValue : [])]
    : props.modelValue;
  
  // 初始化选中状态
  if (props.multiple) {
    const ids = Array.isArray(props.modelValue) ? props.modelValue : [];
    console.log(ids)
    selectedIds.value = new Set(ids);
  } else {
    selectedIds.value = props.modelValue ? new Set([props.modelValue]) : new Set();
  }
  
  dialogVisible.value = true;
  fetchFiles();
}

// 关闭对话框
function closeDialog() {
  dialogVisible.value = false;
  searchQuery.value = '';
}

// 获取文件列表
async function fetchFiles() {
  loading.value = true;
  try {
    const response = await listFiles();
    if (response.success) {
      files.value = response.files || [];
      // 多选模式下，设置已选中的行
      if (props.multiple && fileTableRef.value) {
        await nextTick();
        const selectedFilesList = selectedFiles.value;
        for (const file of selectedFilesList) {
          const row = files.value.find(f => f.id === file.id);
          if (row) {
            fileTableRef.value.toggleRowSelection(row, true);
          }
        }
      }
    } else {
      ElMessage.error('获取文件列表失败');
    }
  } catch (error) {
    console.error('Failed to fetch files:', error);
    ElMessage.error('获取文件列表失败');
  } finally {
    loading.value = false;
  }
}

// 单选模式：选择文件
function selectSingleFile(file) {
  selectedIds.value = new Set([file.id]);
}

// 多选模式：处理选择变化
function handleSelectionChange(selection) {
  selectedIds.value = new Set(selection.map(f => f.id));
}

// 行点击处理
function handleRowClick(row) {
  if (!props.multiple) {
    selectSingleFile(row);
  }
}

// 确认选择
function confirmSelection() {
  if (props.multiple) {
    const selectedArray = Array.from(selectedIds.value);
    emit('update:modelValue', selectedArray);
    emit('change', selectedFiles.value);
  } else {
    const selectedId = Array.from(selectedIds.value)[0] || null;
    emit('update:modelValue', selectedId);
    const selectedFile = files.value.find(f => f.id === selectedId);
    emit('change', selectedFile ? [selectedFile] : []);
  }
  closeDialog();
}

// 取消选择
function cancelSelection() {
  // 恢复初始值
  emit('update:modelValue', initialValue.value);
  closeDialog();
}

// 移除文件（多选模式）
function removeFile(fileId) {
  if (props.disabled) return;
  
  const currentValue = Array.isArray(props.modelValue) ? props.modelValue : [];
  const newValue = currentValue.filter(id => id !== fileId);
  emit('update:modelValue', newValue);
  
  const remainingFiles = files.value.filter(f => newValue.includes(f.id));
  emit('change', remainingFiles);
}

// 格式化文件大小
function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// 格式化日期
function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// 监听modelValue变化
watch(() => props.modelValue, (newVal) => {
  if (props.multiple) {
    selectedIds.value = new Set(Array.isArray(newVal) ? newVal : []);
  } else {
    selectedIds.value = newVal ? new Set([newVal]) : new Set();
  }
}, { immediate: true });

onMounted(() => {
  // 如果有初始值，预加载文件列表以显示文件名
  if (props.modelValue) {
    fetchFiles();
  }
});
</script>

<style scoped>
.file-selector {
  width: 100%;
}

.single-select {
  width: 100%;
}

.multiple-select {
  width: 100%;
}

.file-list-container {
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background-color: var(--el-fill-color-blank);
  min-height: 120px;
  max-height: 300px;
  overflow-y: auto;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 120px;
  color: var(--el-text-color-secondary);
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 8px;
  opacity: 0.5;
}

.empty-text {
  font-size: 14px;
}

.selected-files-list {
  padding: 8px;
}

.file-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  margin-bottom: 4px;
  background-color: var(--el-fill-color-light);
  border-radius: 4px;
  transition: all 0.2s;
}

.file-item:hover {
  background-color: var(--el-fill-color);
}

.file-item:last-child {
  margin-bottom: 0;
}

.file-icon {
  font-size: 20px;
  color: var(--el-color-primary);
  margin-right: 8px;
  flex-shrink: 0;
}

.file-name {
  flex: 1;
  font-size: 14px;
  color: var(--el-text-color-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-right: 12px;
}

.file-size {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-right: 8px;
  flex-shrink: 0;
}

.remove-btn {
  flex-shrink: 0;
  color: var(--el-text-color-secondary);
}

.remove-btn:hover {
  color: var(--el-color-danger);
}

.file-list {
  margin-bottom: 16px;
}

.filter-info {
  margin-top: 16px;
}

:deep(.el-input__inner) {
  cursor: pointer;
}

/* 修复遮罩层样式，确保覆盖所有页面元素 */
:global(.file-selector-modal) {
  z-index: 3000 !important;
}
</style>
