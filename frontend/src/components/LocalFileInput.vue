<template>
  <div class="local-file-input">
    <el-input
      v-model="filePaths"
      :placeholder="placeholder"
      type="textarea"
      :rows="rows"
    />
    <div style="margin-top: 8px; color: #909399; font-size: 12px; line-height: 1.5;">
      ℹ️ 提示：请输入文件的完整绝对路径，每行一个文件路径<br/>
      💡 示例：
      <ul style="margin: 4px 0; padding-left: 20px;">
        <li>Windows: D:\Documents\file.txt</li>
        <li>Linux/macOS: /home/user/documents/file.txt</li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  modelValue: {
    type: [String, Array],
    default: ''
  },
  multiple: {
    type: Boolean,
    default: false
  },
  placeholder: {
    type: String,
    default: '请输入文件完整路径，每行一个'
  },
  rows: {
    type: Number,
    default: 4
  }
});

const emit = defineEmits(['update:modelValue', 'change']);

const filePaths = computed({
  get: () => {
    if (Array.isArray(props.modelValue)) {
      return props.modelValue.join('\n');
    }
    return props.modelValue || '';
  },
  set: (val) => {
    // 将多行文本转换为数组（移除空行）
    const paths = val.split('\n').map(line => line.trim()).filter(line => line);
    emit('update:modelValue', paths);
    emit('change', paths);
  }
});
</script>

<style scoped>
.local-file-input {
  width: 100%;
}

.selected-files-info {
  margin: 8px 0;
  padding: 8px;
  background-color: #f5f7fa;
  border-radius: 4px;
}

.file-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid #ebeef5;
}

.file-info:last-child {
  border-bottom: none;
}

.file-name {
  flex: 1;
  font-size: 14px;
  color: #303133;
  margin-right: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  font-size: 12px;
  color: #909399;
  margin-right: 8px;
  flex-shrink: 0;
}

.file-type {
  font-size: 12px;
  color: #e6a23c;
  flex-shrink: 0;
  font-weight: 500;
}

.file-type.valid {
  color: #67c23a;
}

.file-hint {
  margin: 8px 0;
}

.hint-text {
  font-size: 13px;
  line-height: 1.5;
  color: #909399;
}
</style>
