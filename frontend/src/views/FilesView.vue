<template>
  <div class="files-container">
    <div class="page-header">
      <h1>文件管理</h1>
      <p class="page-subtitle">本地 uploads + YAML 索引；用于工作流复用文件（最小版）</p>
    </div>

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span>上传</span>
          <el-button size="small" @click="refresh" :loading="loading">刷新</el-button>
        </div>
      </template>

      <input ref="fileInput" type="file" multiple @change="onPick" />
      <div style="margin-top: 10px; display:flex; gap:8px;">
        <el-button type="primary" :loading="uploading" :disabled="picked.length===0" @click="onUpload">上传</el-button>
        <el-tag type="info" v-if="picked.length>0">已选择 {{ picked.length }} 个文件</el-tag>
      </div>
    </el-card>

    <el-card shadow="never" style="margin-top: 16px">
      <template #header>
        <div class="card-header">
          <span>文件列表</span>
          <el-button size="small" @click="copySelectedIds" :disabled="selected.length===0">复制选中IDs</el-button>
        </div>
      </template>

      <el-table :data="files" v-loading="loading" @selection-change="onSelectionChange" style="width: 100%">
        <el-table-column type="selection" width="48" />
        <el-table-column prop="id" label="ID" width="140" />
        <el-table-column prop="original_name" label="文件名" />
        <el-table-column prop="size" label="大小" width="120" />
        <el-table-column prop="uploaded_at" label="上传时间" width="220" />
        <el-table-column label="操作" width="220">
          <template #default="scope">
            <el-button size="small" @click="onDownload(scope.row)">下载</el-button>
            <el-button size="small" type="danger" @click="onDelete(scope.row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { listFiles, uploadFiles, deleteFile, downloadUrl } from '@/api/fileService';

const files = ref([]);
const loading = ref(false);
const uploading = ref(false);

const fileInput = ref(null);
const picked = ref([]);
const selected = ref([]);

function onPick(e) {
  picked.value = Array.from(e.target.files || []);
}

async function refresh() {
  loading.value = true;
  try {
    const res = await listFiles();
    if (res.success) files.value = res.files;
  } finally {
    loading.value = false;
  }
}

async function onUpload() {
  uploading.value = true;
  try {
    const res = await uploadFiles(picked.value);
    if (res.success) {
      ElMessage.success(`上传成功：${res.files.length} 个`);
      picked.value = [];
      if (fileInput.value) fileInput.value.value = '';
      await refresh();
    } else {
      ElMessage.error(res.error || '上传失败');
    }
  } finally {
    uploading.value = false;
  }
}

function onSelectionChange(rows) {
  selected.value = rows || [];
}

async function copySelectedIds() {
  const ids = selected.value.map(x => x.id);
  try {
    await navigator.clipboard.writeText(JSON.stringify(ids));
    ElMessage.success('已复制到剪贴板');
  } catch {
    ElMessage.info(`IDs: ${ids.join(', ')}`);
  }
}

function onDownload(row) {
  window.open(downloadUrl(row.id), '_blank');
}

async function onDelete(row) {
  await ElMessageBox.confirm('确认删除该文件？', '提示', { type: 'warning' });
  const res = await deleteFile(row.id);
  if (res.success) {
    ElMessage.success('删除成功');
    await refresh();
  } else {
    ElMessage.error(res.error || '删除失败');
  }
}

onMounted(refresh);
</script>

<style scoped>
.files-container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 20px;
}
.page-header {
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid #ebeef5;
}
.page-header h1 {
  margin: 0 0 6px 0;
  font-size: 28px;
  font-weight: 500;
  color: #303133;
}
.page-subtitle {
  margin: 0;
  font-size: 14px;
  color: #909399;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
