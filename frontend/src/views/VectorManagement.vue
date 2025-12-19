<template>
  <div class="vector-management">
    <el-card class="header-card">
      <div class="header">
        <h2>📦 向量库管理</h2>
        <el-button type="primary" @click="loadCollections" :loading="loading">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
      </div>
    </el-card>

    <!-- 集合列表 -->
    <el-card class="collections-card">
      <template #header>
        <div class="card-header">
          <span>向量集合列表 ({{ collections.length }})</span>
          <el-button text type="primary" @click="showCreateDialog = true">
            <el-icon><Plus /></el-icon>
            索引新文档
          </el-button>
        </div>
      </template>

      <el-table 
        :data="collections" 
        style="width: 100%"
        v-loading="loading"
        empty-text="暂无向量集合"
      >
        <el-table-column prop="name" label="集合名称" width="250">
          <template #default="{ row }">
            <el-tag type="primary">{{ row.name }}</el-tag>
          </template>
        </el-table-column>
        
        <el-table-column prop="total_chunks" label="文档分块数" width="150">
          <template #default="{ row }">
            <el-statistic :value="row.total_chunks" />
          </template>
        </el-table-column>
        
        <el-table-column prop="embedding_dimension" label="向量维度" width="120" />
        
        <el-table-column prop="model_name" label="嵌入模型" min-width="300">
          <template #default="{ row }">
            <el-text size="small">{{ row.model_name || 'N/A' }}</el-text>
          </template>
        </el-table-column>
        
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button-group>
              <el-button 
                size="small" 
                @click="viewCollection(row)"
                :icon="View"
              >
                查看
              </el-button>
              <el-button 
                size="small" 
                type="primary"
                @click="testSearch(row)"
                :icon="Search"
              >
                测试检索
              </el-button>
              <el-button 
                size="small" 
                type="danger"
                @click="confirmDelete(row)"
                :icon="Delete"
              >
                删除
              </el-button>
            </el-button-group>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 创建/索引对话框 -->
    <el-dialog
      v-model="showCreateDialog"
      title="索引新文档"
      width="800px"
      @close="resetIndexForm"
    >
      <el-tabs v-model="indexMode" type="border-card">
        <!-- 方式1: 上传文件 -->
        <el-tab-pane label="📁 上传文件" name="upload">
          <el-form :model="indexForm" label-width="120px">
            <el-form-item label="选择文件">
              <el-upload
                ref="uploadRef"
                :auto-upload="false"
                :limit="1"
                :on-change="handleFileChange"
                :on-remove="handleFileRemove"
                accept=".txt,.md,.json"
                drag
              >
                <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
                <div class="el-upload__text">
                  拖拽文件到此处 或 <em>点击选择文件</em>
                </div>
                <template #tip>
                  <div class="el-upload__tip">
                    支持 .txt、.md、.json 格式，文件需为 UTF-8 编码
                  </div>
                </template>
              </el-upload>
            </el-form-item>

            <el-divider />

            <el-form-item label="集合名称">
              <el-input v-model="indexForm.collection_name" placeholder="documents" />
              <el-text size="small" type="info">相同名称的文档存储在同一集合中</el-text>
            </el-form-item>

            <el-form-item label="文档ID">
              <el-input v-model="indexForm.document_id" placeholder="自动使用文件名" />
              <el-text size="small" type="info">留空则使用文件名作为ID</el-text>
            </el-form-item>

            <el-form-item label="文档类型">
              <el-select v-model="indexForm.metadata.document_type" style="width: 100%">
                <el-option label="通用文档" value="general" />
                <el-option label="应急预案" value="emergency_plan" />
                <el-option label="技术报告" value="report" />
                <el-option label="操作手册" value="manual" />
              </el-select>
            </el-form-item>

            <el-form-item label="分块大小">
              <el-input-number v-model="indexForm.chunk_size" :min="100" :max="2000" :step="100" />
              <el-text size="small" type="info" style="margin-left: 10px">字符数，建议300-800</el-text>
            </el-form-item>

            <el-form-item label="分块重叠">
              <el-input-number v-model="indexForm.overlap" :min="0" :max="500" :step="10" />
              <el-text size="small" type="info" style="margin-left: 10px">建议为分块大小的10%</el-text>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <!-- 方式2: 选择已上传的文件 -->
        <el-tab-pane label="📂 文件管理系统" name="select">
          <el-form :model="indexForm" label-width="120px">
            <el-form-item label="选择文件">
              <el-select 
                v-model="indexForm.file_id" 
                placeholder="请选择文件"
                style="width: 100%"
                filterable
                @focus="loadSystemFiles"
              >
                <el-option
                  v-for="file in systemFiles"
                  :key="file.id"
                  :label="`${file.name} (${formatFileSize(file.size)})`"
                  :value="file.id"
                >
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span>{{ file.name }}</span>
                    <el-tag size="small" type="info">{{ formatFileSize(file.size) }}</el-tag>
                  </div>
                </el-option>
              </el-select>
              <el-text size="small" type="info">从文件管理系统中选择已上传的文件</el-text>
            </el-form-item>

            <el-divider />

            <el-form-item label="集合名称">
              <el-input v-model="indexForm.collection_name" placeholder="documents" />
            </el-form-item>

            <el-form-item label="文档ID">
              <el-input v-model="indexForm.document_id" placeholder="自动使用文件ID" />
            </el-form-item>

            <el-form-item label="文档类型">
              <el-select v-model="indexForm.metadata.document_type" style="width: 100%">
                <el-option label="通用文档" value="general" />
                <el-option label="应急预案" value="emergency_plan" />
                <el-option label="技术报告" value="report" />
                <el-option label="操作手册" value="manual" />
              </el-select>
            </el-form-item>

            <el-form-item label="分块大小">
              <el-input-number v-model="indexForm.chunk_size" :min="100" :max="2000" :step="100" />
              <el-text size="small" type="info" style="margin-left: 10px">字符数，建议300-800</el-text>
            </el-form-item>

            <el-form-item label="分块重叠">
              <el-input-number v-model="indexForm.overlap" :min="0" :max="500" :step="10" />
              <el-text size="small" type="info" style="margin-left: 10px">建议为分块大小的10%</el-text>
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <!-- 方式3: 直接输入文本 -->
        <el-tab-pane label="✏️ 直接输入" name="text">
          <el-form :model="indexForm" label-width="120px">
            <el-form-item label="集合名称">
              <el-input v-model="indexForm.collection_name" placeholder="documents" />
            </el-form-item>

            <el-form-item label="文档ID">
              <el-input v-model="indexForm.document_id" placeholder="my_document_001" />
            </el-form-item>

            <el-form-item label="文档内容">
              <el-input
                v-model="indexForm.text"
                type="textarea"
                :rows="12"
                placeholder="输入要索引的文档内容..."
              />
            </el-form-item>

            <el-form-item label="文档来源">
              <el-input v-model="indexForm.metadata.source" placeholder="例如：应急预案、技术文档" />
            </el-form-item>

            <el-form-item label="文档类型">
              <el-select v-model="indexForm.metadata.document_type" style="width: 100%">
                <el-option label="通用文档" value="general" />
                <el-option label="应急预案" value="emergency_plan" />
                <el-option label="技术报告" value="report" />
                <el-option label="操作手册" value="manual" />
              </el-select>
            </el-form-item>

            <el-form-item label="分块大小">
              <el-input-number v-model="indexForm.chunk_size" :min="100" :max="2000" :step="100" />
              <el-text size="small" type="info" style="margin-left: 10px">字符数，建议300-800</el-text>
            </el-form-item>

            <el-form-item label="分块重叠">
              <el-input-number v-model="indexForm.overlap" :min="0" :max="500" :step="10" />
              <el-text size="small" type="info" style="margin-left: 10px">建议为分块大小的10%</el-text>
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>

      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button 
          type="primary" 
          @click="indexDocument"
          :loading="indexing"
          :icon="Upload"
        >
          开始索引
        </el-button>
      </template>
    </el-dialog>

    <!-- 检索测试对话框 -->
    <el-dialog
      v-model="showSearchDialog"
      title="测试向量检索"
      width="800px"
    >
      <el-form>
        <el-form-item label="查询内容">
          <el-input
            v-model="searchQuery"
            placeholder="输入查询问题..."
            @keyup.enter="performSearch"
          >
            <template #append>
              <el-button 
                :icon="Search" 
                @click="performSearch"
                :loading="searching"
              />
            </template>
          </el-input>
        </el-form-item>

        <el-form-item label="返回数量">
          <el-input-number v-model="searchTopK" :min="1" :max="20" />
        </el-form-item>
      </el-form>

      <el-divider>检索结果</el-divider>

      <div v-if="searchResults.length > 0" class="search-results">
        <el-card
          v-for="(result, index) in searchResults"
          :key="index"
          class="result-card"
          shadow="hover"
        >
          <template #header>
            <div class="result-header">
              <span>
                <el-tag size="small">排名 {{ index + 1 }}</el-tag>
                <el-tag size="small" type="success" style="margin-left: 8px">
                  相似度: {{ (result.similarity * 100).toFixed(2) }}%
                </el-tag>
              </span>
              <el-text size="small" type="info">
                来源: {{ result.metadata?.document_id || 'unknown' }}
              </el-text>
            </div>
          </template>
          
          <div class="result-content">
            {{ result.text }}
          </div>

          <template #footer>
            <el-text size="small" type="info">
              分块: {{ result.metadata?.chunk_index }}/{{ result.metadata?.chunk_total }}
            </el-text>
          </template>
        </el-card>
      </div>

      <el-empty v-else-if="searched" description="未找到匹配结果" />
    </el-dialog>

    <!-- 集合详情对话框 -->
    <el-dialog
      v-model="showDetailDialog"
      :title="`集合详情: ${selectedCollection?.name}`"
      width="600px"
    >
      <el-descriptions :column="1" border v-if="selectedCollection">
        <el-descriptions-item label="集合名称">
          {{ selectedCollection.name }}
        </el-descriptions-item>
        <el-descriptions-item label="文档分块总数">
          {{ selectedCollection.total_chunks }}
        </el-descriptions-item>
        <el-descriptions-item label="向量维度">
          {{ selectedCollection.embedding_dimension }}
        </el-descriptions-item>
        <el-descriptions-item label="嵌入模型">
          {{ selectedCollection.model_name }}
        </el-descriptions-item>
        <el-descriptions-item label="元数据">
          <pre>{{ JSON.stringify(selectedCollection.metadata, null, 2) }}</pre>
        </el-descriptions-item>
      </el-descriptions>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, Plus, View, Search, Delete, Upload, UploadFilled } from '@element-plus/icons-vue'
import { vectorService } from '@/api'
import axios from 'axios'

// 状态
const loading = ref(false)
const collections = ref([])
const showCreateDialog = ref(false)
const showSearchDialog = ref(false)
const showDetailDialog = ref(false)
const selectedCollection = ref(null)
const indexing = ref(false)
const searching = ref(false)
const searched = ref(false)

// 索引模式：upload(上传文件) / select(选择文件) / text(直接输入)
const indexMode = ref('upload')

// 文件相关
const uploadRef = ref(null)
const selectedFile = ref(null)
const systemFiles = ref([])

// 索引表单
const indexForm = ref({
  collection_name: 'documents',
  document_id: '',
  text: '',
  file_id: '',
  metadata: {
    source: '',
    document_type: 'general'
  },
  chunk_size: 500,
  overlap: 50
})

// 检索相关
const searchQuery = ref('')
const searchTopK = ref(5)
const searchResults = ref([])

// 加载集合列表
const loadCollections = async () => {
  loading.value = true
  try {
    const response = await vectorService.getCollections()
    if (response.success) {
      collections.value = response.data
      ElMessage.success(`加载成功，共 ${response.count} 个集合`)
    }
  } catch (error) {
    ElMessage.error('加载集合列表失败: ' + (error.response?.data?.error || error.message))
  } finally {
    loading.value = false
  }
}

// 文件选择变化
const handleFileChange = (file) => {
  selectedFile.value = file
  if (!indexForm.value.document_id) {
    indexForm.value.document_id = file.name
  }
}

// 文件移除
const handleFileRemove = () => {
  selectedFile.value = null
}

// 加载文件管理系统中的文件
const loadSystemFiles = async () => {
  try {
    const response = await axios.get('/api/files')
    if (response.data.success) {
      systemFiles.value = response.data.data
    }
  } catch (error) {
    console.error('加载文件列表失败:', error)
  }
}

// 格式化文件大小
const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

// 重置表单
const resetIndexForm = () => {
  indexForm.value = {
    collection_name: 'documents',
    document_id: '',
    text: '',
    file_id: '',
    metadata: { source: '', document_type: 'general' },
    chunk_size: 500,
    overlap: 50
  }
  selectedFile.value = null
  indexMode.value = 'upload'
}

// 索引文档
const indexDocument = async () => {
  indexing.value = true
  try {
    let response

    // 方式1: 上传文件
    if (indexMode.value === 'upload') {
      if (!selectedFile.value) {
        ElMessage.warning('请选择要上传的文件')
        indexing.value = false
        return
      }

      const formData = new FormData()
      formData.append('file', selectedFile.value.raw)
      formData.append('collection_name', indexForm.value.collection_name)
      formData.append('document_id', indexForm.value.document_id || selectedFile.value.name)
      formData.append('document_type', indexForm.value.metadata.document_type)
      formData.append('chunk_size', indexForm.value.chunk_size)
      formData.append('overlap', indexForm.value.overlap)

      response = await axios.post('/api/vector/index', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
    }
    // 方式2: 选择文件
    else if (indexMode.value === 'select') {
      if (!indexForm.value.file_id) {
        ElMessage.warning('请选择文件')
        indexing.value = false
        return
      }

      response = await vectorService.indexDocument({
        collection_name: indexForm.value.collection_name,
        document_id: indexForm.value.document_id || indexForm.value.file_id,
        file_id: indexForm.value.file_id,
        metadata: indexForm.value.metadata,
        chunk_size: indexForm.value.chunk_size,
        overlap: indexForm.value.overlap
      })
    }
    // 方式3: 直接输入文本
    else {
      if (!indexForm.value.document_id || !indexForm.value.text) {
        ElMessage.warning('请填写文档ID和内容')
        indexing.value = false
        return
      }

      response = await vectorService.indexDocument(indexForm.value)
    }

    if (response.data?.success || response.success) {
      const data = response.data?.data || response.data
      ElMessage.success(`索引成功！生成 ${data.chunk_count} 个分块`)
      showCreateDialog.value = false
      loadCollections()
      resetIndexForm()
    }
  } catch (error) {
    console.error('索引失败:', error)
    ElMessage.error('索引失败: ' + (error.response?.data?.error || error.message))
  } finally {
    indexing.value = false
  }
}

// 查看集合
const viewCollection = (collection) => {
  selectedCollection.value = collection
  showDetailDialog.value = true
}

// 测试检索
const testSearch = (collection) => {
  selectedCollection.value = collection
  searchQuery.value = ''
  searchResults.value = []
  searched.value = false
  showSearchDialog.value = true
}

// 执行检索
const performSearch = async () => {
  if (!searchQuery.value) {
    ElMessage.warning('请输入查询内容')
    return
  }

  searching.value = true
  searched.value = false
  try {
    const response = await vectorService.searchVectors(
      selectedCollection.value.name,
      searchQuery.value,
      searchTopK.value
    )
    
    if (response.success) {
      searchResults.value = response.data.results
      searched.value = true
      ElMessage.success(`检索完成，找到 ${searchResults.value.length} 条结果`)
    }
  } catch (error) {
    ElMessage.error('检索失败: ' + (error.response?.data?.error || error.message))
  } finally {
    searching.value = false
  }
}

// 确认删除
const confirmDelete = (collection) => {
  ElMessageBox.confirm(
    `确定要删除集合 "${collection.name}" 吗？此操作不可恢复！`,
    '警告',
    {
      confirmButtonText: '确定删除',
      cancelButtonText: '取消',
      type: 'warning',
    }
  ).then(() => {
    deleteCollection(collection.name)
  })
}

// 删除集合
const deleteCollection = async (collectionName) => {
  try {
    const response = await vectorService.deleteCollection(collectionName)
    if (response.success) {
      ElMessage.success('删除成功')
      loadCollections()
    }
  } catch (error) {
    ElMessage.error('删除失败: ' + (error.response?.data?.error || error.message))
  }
}

// 初始化
onMounted(() => {
  loadCollections()
})
</script>

<style scoped>
.vector-management {
  padding: 20px;
}

.header-card {
  margin-bottom: 20px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header h2 {
  margin: 0;
}

.collections-card {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.search-results {
  max-height: 500px;
  overflow-y: auto;
}

.result-card {
  margin-bottom: 16px;
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.result-content {
  line-height: 1.6;
  color: #606266;
  padding: 10px 0;
  max-height: 200px;
  overflow-y: auto;
}
</style>

/* 文件上传样式增强 */
:deep(.el-upload-dragger) {
  padding: 40px 20px;
}

:deep(.el-icon--upload) {
  font-size: 67px;
  color: #c0c4cc;
  margin-bottom: 16px;
}

:deep(.el-upload__text) {
  color: #606266;
  font-size: 14px;
}

:deep(.el-upload__text em) {
  color: #409eff;
  font-style: normal;
}

/* 标签页样式优化 */
:deep(.el-tabs--border-card) {
  box-shadow: none;
  border: 1px solid #dcdfe6;
}

:deep(.el-tabs__content) {
  padding: 24px;
}

:deep(.el-tab-pane) {
  min-height: 400px;
}
