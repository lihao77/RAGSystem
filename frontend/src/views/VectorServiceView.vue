<template>
  <div class="vector-service-container">
    <!-- 页面头部 -->
    <div class="page-header">
      <h1>向量知识库</h1>
      <p class="page-subtitle">管理向量数据库、配置 Embedding 模型及相关工具</p>
    </div>

    <el-tabs v-model="activeTab" class="vector-tabs">
      <!-- 向量库管理 Tab -->
      <el-tab-pane label="向量库管理" name="store">
        <template #label>
          <span class="custom-tab-label">
            <el-icon><DataLine /></el-icon>
            <span>向量库管理</span>
          </span>
        </template>
        
        <!-- 集合列表 -->
        <el-card class="box-card" shadow="hover">
          <template #header>
            <div class="card-header">
              <span>向量集合列表</span>
              <div class="header-actions">
                <el-button type="primary" size="small" @click="showCreateDialog = true">
                  <el-icon><Plus /></el-icon> 索引新文档
                </el-button>
                <el-button size="small" @click="refreshCollections" :loading="loading.collections">
                  <el-icon><Refresh /></el-icon> 刷新
                </el-button>
              </div>
            </div>
          </template>
          
          <el-table :data="collections" v-loading="loading.collections" style="width: 100%" empty-text="暂无向量集合">
            <el-table-column prop="name" label="集合名称" width="200">
               <template #default="{ row }">
                 <el-tag>{{ row.name }}</el-tag>
               </template>
            </el-table-column>
            <el-table-column prop="total_chunks" label="文档分块数" width="120" align="center" />
            <el-table-column prop="embedding_dimension" label="向量维度" width="120" align="center" />
            <el-table-column prop="model_name" label="模型信息" min-width="150" show-overflow-tooltip>
                <template #default="{ row }">
                    <span v-if="row.model_name">{{ row.model_name }}</span>
                    <span v-else class="text-gray">N/A</span>
                </template>
            </el-table-column>
            <el-table-column label="操作" align="right" width="250">
              <template #default="scope">
                <el-button size="small" @click="viewCollection(scope.row)">
                  <el-icon><View /></el-icon> 详情
                </el-button>
                <el-button size="small" @click="openSearchTest(scope.row.name)">
                  <el-icon><Search /></el-icon> 检索
                </el-button>
                <el-popconfirm 
                  title="确定要删除该集合吗？此操作不可恢复。"
                  @confirm="handleDeleteCollection(scope.row.name)"
                >
                  <template #reference>
                    <el-button size="small" type="danger">
                      <el-icon><Delete /></el-icon>
                    </el-button>
                  </template>
                </el-popconfirm>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <!-- 检索测试区域 -->
        <el-card v-if="currentCollection" class="box-card search-card" shadow="hover">
          <template #header>
            <div class="card-header">
              <span>检索测试: {{ currentCollection }}</span>
              <el-button size="small" @click="currentCollection = null">关闭</el-button>
            </div>
          </template>
          
          <div class="search-box">
            <el-input 
              v-model="searchQuery" 
              placeholder="输入查询文本..." 
              class="search-input"
              @keyup.enter="handleSearch"
            >
              <template #append>
                <el-button @click="handleSearch" :loading="loading.search">
                  <el-icon><Search /></el-icon> 搜索
                </el-button>
              </template>
            </el-input>
            
            <div class="search-options">
              <span>Top K: </span>
              <el-input-number v-model="searchTopK" :min="1" :max="20" size="small" />
            </div>
          </div>

          <div v-if="searchResults.length > 0" class="search-results">
            <div v-for="(result, index) in searchResults" :key="index" class="result-item">
              <div class="result-header">
                <el-tag size="small" :type="getScoreTagType(result.score || result.similarity)">
                  相似度: {{ ((result.score || result.similarity) * 100).toFixed(2) }}%
                </el-tag>
                <span class="result-source">{{ result.metadata?.source || result.metadata?.document_id || '未知来源' }}</span>
              </div>
              <div class="result-content">{{ result.content || result.text }}</div>
              <div class="result-footer">
                  <span v-if="result.metadata?.chunk_index !== undefined">分块: {{ result.metadata.chunk_index }}/{{ result.metadata.chunk_total }}</span>
              </div>
            </div>
          </div>
          <el-empty v-else-if="searchPerformed" description="未找到相关结果" />
        </el-card>
      </el-tab-pane>

      <!-- Embedding 配置 Tab -->
      <el-tab-pane label="Embedding 配置" name="config">
        <template #label>
          <span class="custom-tab-label">
            <el-icon><Setting /></el-icon>
            <span>Embedding 配置</span>
          </span>
        </template>
        
        <el-card class="box-card" shadow="never">
          <template #header>
            <div class="card-header">
              <span>嵌入模型配置</span>
              <div class="header-actions">
                <el-button type="primary" :loading="loading.saving" @click="saveConfig">
                  <el-icon><Check /></el-icon> 保存配置
                </el-button>
              </div>
            </div>
          </template>

          <el-form :model="config.embedding" label-width="120px" label-position="left">
            <el-alert
                v-if="!config.embedding.provider"
                title="尚未配置 Embedding 服务，向量知识库功能不可用"
                type="warning"
                :closable="false"
                show-icon
                style="margin-bottom: 20px"
            />
            <el-alert
                v-else
                title="Embedding 服务已升级为使用 Model Adapter 统一管理"
                type="success"
                :closable="false"
                show-icon
                style="margin-bottom: 20px"
            />

            <el-form-item label="Provider">
              <el-select v-model="config.embedding.provider" placeholder="选择 Provider" style="width: 100%" @change="handleProviderChange" clearable>
                <el-option
                  v-for="provider in availableProviders"
                  :key="provider.name"
                  :label="provider.name + ' (' + provider.provider_type + ')'"
                  :value="provider.name"
                />
              </el-select>
              <div class="form-tip">
                从 Model Adapter 中选择已配置的 Provider。如果没有，请先去 <router-link to="/model-adapter">Model Adapter</router-link> 配置。
              </div>
            </el-form-item>

            <el-form-item label="模型名称">
              <el-select 
                v-model="config.embedding.model_name" 
                placeholder="选择或输入模型名称" 
                style="width: 100%" 
                filterable 
                allow-create
                default-first-option
              >
                 <!-- 优先显示 Model Map 中的 embedding 模型 -->
                 <el-option 
                    v-if="currentProviderModels.embedding"
                    :label="currentProviderModels.embedding + ' (推荐)'"
                    :value="currentProviderModels.embedding"
                 />
                 <!-- 显示列表中的其他模型 -->
                 <el-option
                    v-for="model in currentProviderModels.list"
                    :key="model"
                    :label="model"
                    :value="model"
                 />
              </el-select>
            </el-form-item>

            <el-form-item label="批处理大小">
               <el-input-number v-model="config.embedding.batch_size" :min="1" :max="500" :step="10" />
               <div class="form-tip">单次请求处理的文本数量，建议值: 10-100</div>
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>

      <!-- 向量工具 Tab -->
      <el-tab-pane label="向量工具" name="tools">
        <template #label>
          <span class="custom-tab-label">
            <el-icon><Tools /></el-icon>
            <span>向量工具</span>
          </span>
        </template>
        
        <el-row :gutter="20">
          <el-col :span="12">
            <el-card class="box-card" shadow="hover" header="语义相似度计算器">
               <el-form label-position="top">
                 <el-form-item label="文本 A">
                   <el-input type="textarea" v-model="similarity.textA" :rows="3" placeholder="输入第一段文本" />
                 </el-form-item>
                 <el-form-item label="文本 B">
                   <el-input type="textarea" v-model="similarity.textB" :rows="3" placeholder="输入第二段文本" />
                 </el-form-item>
                 <el-button type="primary" @click="calculateSimilarity" :loading="loading.similarity" style="width: 100%">
                   计算相似度
                 </el-button>
               </el-form>
               
               <div v-if="similarity.score !== null" class="similarity-result">
                 <div class="score-circle">
                   {{ (similarity.score * 100).toFixed(1) }}%
                 </div>
                 <p class="score-label">相似度评分</p>
               </div>
            </el-card>
          </el-col>
          <el-col :span="12">
            <el-card class="box-card" shadow="hover" header="功能介绍">
              <p>Embedding（向量化）是将文本转换为高维向量的技术。</p>
              <p>除了用于 RAG 系统的检索外，还可以用于：</p>
              <ul>
                <li><strong>语义搜索</strong>：理解查询意图，而非关键词匹配。</li>
                <li><strong>推荐系统</strong>：计算内容相似度进行推荐。</li>
                <li><strong>文本聚类</strong>：发现数据中的话题分布。</li>
                <li><strong>异常检测</strong>：识别语义偏离的文本。</li>
              </ul>
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>
    </el-tabs>

    <!-- 创建/索引对话框 -->
    <el-dialog v-model="showCreateDialog" title="索引新文档" width="800px" @close="resetIndexForm">
      <el-tabs v-model="indexMode" type="border-card" class="index-tabs">
        <!-- 方式1: 上传文件 -->
        <el-tab-pane label="📁 上传文件" name="upload">
          <el-form :model="indexForm" label-width="120px">
            <el-form-item label="选择文件">
              <el-upload ref="uploadRef" :auto-upload="false" :limit="1" :on-change="handleFileChange"
                :on-remove="handleFileRemove" accept=".txt,.md,.json" drag>
                <el-icon class="el-icon--upload">
                  <UploadFilled />
                </el-icon>
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
              <el-input v-model="indexForm.collection_name" placeholder="documents">
                <template #append>
                  <el-button :icon="Refresh" @click="autoSetCollectionName" title="根据文档类型自动设置" />
                </template>
              </el-input>
            </el-form-item>

            <el-form-item label="文档ID">
              <el-input v-model="indexForm.document_id" placeholder="自动使用文件名" />
              <el-text size="small" type="info">留空则使用文件名作为ID</el-text>
            </el-form-item>

            <el-form-item label="文档类型">
              <el-select v-model="indexForm.metadata.document_type" style="width: 100%"
                @change="handleDocumentTypeChange">
                <el-option label="通用文档" value="general" />
                <el-option label="应急预案" value="emergency_plan" />
                <el-option label="技术报告" value="report" />
                <el-option label="操作手册" value="manual" />
              </el-select>
            </el-form-item>

            <el-form-item label="分块大小">
              <el-input-number v-model="indexForm.chunk_size" :min="100" :max="2000" :step="100" />
            </el-form-item>

            <el-form-item label="分块重叠">
              <el-input-number v-model="indexForm.overlap" :min="0" :max="500" :step="10" />
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <!-- 方式2: 选择已上传的文件 -->
        <el-tab-pane label="📂 文件管理系统" name="select">
          <el-form :model="indexForm" label-width="120px">
            <el-form-item label="选择文件">
              <el-select v-model="indexForm.file_id" placeholder="请选择文件" style="width: 100%" filterable
                @focus="loadSystemFiles">
                <el-option v-for="file in systemFiles" :key="file.id"
                  :label="`${file.original_name} (${formatFileSize(file.size)})`" :value="file.id">
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span>{{ file.original_name }}</span>
                    <el-tag size="small" type="info">{{ formatFileSize(file.size) }}</el-tag>
                  </div>
                </el-option>
              </el-select>
            </el-form-item>

            <el-divider />

            <el-form-item label="集合名称">
              <el-input v-model="indexForm.collection_name" placeholder="documents">
                <template #append>
                  <el-button :icon="Refresh" @click="autoSetCollectionName" title="根据文档类型自动设置" />
                </template>
              </el-input>
            </el-form-item>

            <el-form-item label="文档ID">
              <el-input v-model="indexForm.document_id" placeholder="自动使用文件ID" />
            </el-form-item>

             <el-form-item label="文档类型">
              <el-select v-model="indexForm.metadata.document_type" style="width: 100%"
                @change="handleDocumentTypeChange">
                <el-option label="通用文档" value="general" />
                <el-option label="应急预案" value="emergency_plan" />
                <el-option label="技术报告" value="report" />
                <el-option label="操作手册" value="manual" />
              </el-select>
            </el-form-item>

            <el-form-item label="分块大小">
              <el-input-number v-model="indexForm.chunk_size" :min="100" :max="2000" :step="100" />
            </el-form-item>

            <el-form-item label="分块重叠">
              <el-input-number v-model="indexForm.overlap" :min="0" :max="500" :step="10" />
            </el-form-item>
          </el-form>
        </el-tab-pane>

        <!-- 方式3: 直接输入文本 -->
        <el-tab-pane label="✏️ 直接输入" name="text">
          <el-form :model="indexForm" label-width="120px">
            <el-form-item label="集合名称">
              <el-input v-model="indexForm.collection_name" placeholder="documents">
                <template #append>
                  <el-button :icon="Refresh" @click="autoSetCollectionName" title="根据文档类型自动设置" />
                </template>
              </el-input>
            </el-form-item>

            <el-form-item label="文档ID">
              <el-input v-model="indexForm.document_id" placeholder="my_document_001" />
            </el-form-item>

            <el-form-item label="文档内容">
              <el-input v-model="indexForm.text" type="textarea" :rows="8" placeholder="输入要索引的文档内容..." />
            </el-form-item>

             <el-form-item label="文档类型">
              <el-select v-model="indexForm.metadata.document_type" style="width: 100%"
                @change="handleDocumentTypeChange">
                <el-option label="通用文档" value="general" />
                <el-option label="应急预案" value="emergency_plan" />
                <el-option label="技术报告" value="report" />
                <el-option label="操作手册" value="manual" />
              </el-select>
            </el-form-item>

            <el-form-item label="分块大小">
              <el-input-number v-model="indexForm.chunk_size" :min="100" :max="2000" :step="100" />
            </el-form-item>

            <el-form-item label="分块重叠">
              <el-input-number v-model="indexForm.overlap" :min="0" :max="500" :step="10" />
            </el-form-item>
          </el-form>
        </el-tab-pane>
      </el-tabs>

      <template #footer>
        <el-button @click="showCreateDialog = false">取消</el-button>
        <el-button type="primary" @click="indexDocument" :loading="indexing">
          <el-icon><Upload /></el-icon> 开始索引
        </el-button>
      </template>
    </el-dialog>

    <!-- 集合详情对话框 -->
    <el-dialog v-model="showDetailDialog" :title="`集合详情: ${selectedCollection?.name}`" width="600px">
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
          {{ selectedCollection.model_name || 'N/A' }}
        </el-descriptions-item>
        <el-descriptions-item label="元数据">
          <pre>{{ JSON.stringify(selectedCollection.metadata, null, 2) }}</pre>
        </el-descriptions-item>
      </el-descriptions>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { 
  DataLine, Setting, Refresh, Search, Delete, 
  Link, Key, Cpu, Check, Tools, Plus, View, Upload, UploadFilled 
} from '@element-plus/icons-vue'
import { getCollections, deleteCollection, searchVectors, indexFileUpload, indexDocument as apiIndexDocument } from '@/api/vectorService'
import { getRawConfig, updateConfig, reloadConfig } from '@/api/config'
import { modelAdapterService } from '@/api'
import { listFiles } from '@/api/fileService'

defineOptions({ name: 'VectorServiceView' })

const activeTab = ref('store')

// 状态
const loading = reactive({
  collections: false,
  search: false,
  saving: false,
  similarity: false
})

const indexing = ref(false)
const showCreateDialog = ref(false)
const showDetailDialog = ref(false)
const selectedCollection = ref(null)

// Provider 数据
const availableProviders = ref([])
const currentProviderModels = reactive({
  embedding: '',
  list: []
})

// 索引相关
const indexMode = ref('upload')
const uploadRef = ref(null)
const selectedFile = ref(null)
const systemFiles = ref([])

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

// 向量库数据
const collections = ref([])
const currentCollection = ref(null)
const searchQuery = ref('')
const searchTopK = ref(5)
const searchResults = ref([])
const searchPerformed = ref(false)

// Embedding 配置数据
const config = reactive({
  embedding: {
    provider: '',
    model_name: '',
    batch_size: 100
  }
})

// 加载 Provider 列表
const loadProviders = async () => {
  try {
    const res = await modelAdapterService.getProviders()
    if (res.success) {
      // 包含embedding模型的 Provider 列表
      availableProviders.value = res.providers.filter(p => p.models?.length > 0 || p.model_map?.embedding)
      
      // 如果已选择 provider，加载其模型
      if (config.embedding.provider) {
        handleProviderChange(config.embedding.provider)
      }
    }
  } catch (error) {
    ElMessage.error('加载 Provider 列表失败')
  }
}

// 处理 Provider 变更
const handleProviderChange = (providerName) => {
  const provider = availableProviders.value.find(p => p.name === providerName)
  if (provider) {
    // 重置模型列表
    // 从 model_map 和 models (兼容旧版) 中收集所有模型
    const allModels = new Set(provider.models || [])
    if (provider.model_map) {
      Object.values(provider.model_map).forEach(m => {
        if (m && m.trim()) allModels.add(m.trim())
      })
    }
    
    currentProviderModels.list = Array.from(allModels)
    currentProviderModels.embedding = provider.model_map?.embedding || ''
    
    // 如果当前没有选择模型，且有推荐的 embedding 模型，自动选择
    if (!config.embedding.model_name && currentProviderModels.embedding) {
      config.embedding.model_name = currentProviderModels.embedding
    }
  } else {
    currentProviderModels.list = []
    currentProviderModels.embedding = ''
  }
}

// 相似度工具数据
const similarity = reactive({
  textA: '',
  textB: '',
  score: null
})

// 文档类型到集合名称的映射
const documentTypeToCollection = {
  'general': 'documents',
  'emergency_plan': 'emergency_plans',
  'report': 'reports',
  'manual': 'manuals'
}

// 方法：自动设置集合名称
const autoSetCollectionName = () => {
  const docType = indexForm.value.metadata.document_type
  indexForm.value.collection_name = documentTypeToCollection[docType] || 'documents'
}

const handleDocumentTypeChange = () => {
  autoSetCollectionName()
}

// 方法：加载集合
const refreshCollections = async () => {
  loading.collections = true
  try {
    const res = await getCollections()
    if (res.success) {
      collections.value = res.data
    } else {
      ElMessage.error(res.error || '获取集合列表失败')
    }
  } catch (error) {
    ElMessage.error('获取集合列表失败: ' + error.message)
  } finally {
    loading.collections = false
  }
}

// 方法：删除集合
const handleDeleteCollection = async (name) => {
  try {
    const res = await deleteCollection(name)
    if (res.success) {
      ElMessage.success('删除成功')
      refreshCollections()
      if (currentCollection.value === name) {
        currentCollection.value = null
      }
    } else {
      ElMessage.error(res.error || '删除失败')
    }
  } catch (error) {
    ElMessage.error('删除失败: ' + error.message)
  }
}

// 方法：打开检索测试
const openSearchTest = (name) => {
  currentCollection.value = name
  searchResults.value = []
  searchPerformed.value = false
  searchQuery.value = ''
}

// 查看详情
const viewCollection = (collection) => {
  selectedCollection.value = collection
  showDetailDialog.value = true
}

// 方法：执行检索
const handleSearch = async () => {
  if (!searchQuery.value) return
  loading.search = true
  searchPerformed.value = true
  try {
    const res = await searchVectors(currentCollection.value, searchQuery.value, searchTopK.value)
    if (res.success) {
      searchResults.value = res.data.results
    } else {
      ElMessage.error(res.error || '检索失败')
    }
  } catch (error) {
    ElMessage.error('检索失败: ' + error.message)
  } finally {
    loading.search = false
  }
}

// 文件相关
const handleFileChange = (file) => {
  selectedFile.value = file
  if (!indexForm.value.document_id) {
    indexForm.value.document_id = file.name
  }
}

const handleFileRemove = () => {
  selectedFile.value = null
}

const loadSystemFiles = async () => {
  try {
    const response = await listFiles()
    if (response.success) {
      systemFiles.value = response.files
    }
  } catch (error) {
    console.error('加载文件列表失败:', error)
  }
}

const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

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

      response = await indexFileUpload(formData)
    }
    // 方式2: 选择文件
    else if (indexMode.value === 'select') {
      if (!indexForm.value.file_id) {
        ElMessage.warning('请选择文件')
        indexing.value = false
        return
      }

      response = await apiIndexDocument({
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

      response = await apiIndexDocument(indexForm.value)
    }

    if (response.data?.success || response.success) {
      const data = response.data?.data || response.data
      ElMessage.success(`索引成功！生成 ${data.chunk_count} 个分块`)
      showCreateDialog.value = false
      refreshCollections()
      resetIndexForm()
    }
  } catch (error) {
    ElMessage.error('索引失败: ' + (error.response?.data?.error || error.message))
  } finally {
    indexing.value = false
  }
}

// 方法：加载配置
const loadConfig = async () => {
  try {
    const res = await getRawConfig()
    if (res.success && res.data.embedding) {
      const embeddingData = res.data.embedding
      
      // 加载配置
      config.embedding.provider = embeddingData.provider || ''
      config.embedding.model_name = embeddingData.model_name || ''
      config.embedding.batch_size = embeddingData.batch_size || 100
      
      // 加载 Provider 列表以匹配模型选项
      await loadProviders()
    }
  } catch (error) {
    console.error('加载配置错误:', error)
    ElMessage.error('加载配置失败')
  }
}

// 方法：保存配置
const saveConfig = async () => {
  loading.saving = true
  try {
    // 构造更新数据
    const updateData = {
      embedding: {
        provider: config.embedding.provider,
        model_name: config.embedding.model_name,
        batch_size: config.embedding.batch_size
      }
    }
    
    const res = await updateConfig(updateData)
    if (res.success) {
      ElMessage.success('配置已保存')
      await reloadConfig() // 热重载
    } else {
      ElMessage.error(res.message || '保存失败')
    }
  } catch (error) {
    ElMessage.error('保存失败: ' + error.message)
  } finally {
    loading.saving = false
  }
}

// 方法：计算相似度
const calculateSimilarity = async () => {
  if (!similarity.textA || !similarity.textB) {
    ElMessage.warning('请输入两段文本')
    return
  }
  
  loading.similarity = true
  try {
    await new Promise(resolve => setTimeout(resolve, 800))
    // 简单的 Jaccard 相似度模拟 (因为没有后端接口)
    const setA = new Set(similarity.textA.split(''))
    const setB = new Set(similarity.textB.split(''))
    const intersection = new Set([...setA].filter(x => setB.has(x)))
    const union = new Set([...setA, ...setB])
    similarity.score = intersection.size / union.size
    
    ElMessage.info('演示模式：基于字符的 Jaccard 相似度')
  } catch (error) {
    ElMessage.error('计算失败')
  } finally {
    loading.similarity = false
  }
}

const getScoreTagType = (score) => {
  if (score > 0.8) return 'success'
  if (score > 0.6) return 'primary'
  if (score > 0.4) return 'warning'
  return 'info'
}

onMounted(() => {
  refreshCollections()
  loadConfig()
})
</script>

<style scoped>
.vector-service-container {
  padding: 20px;
  max-width: 1400px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 24px;
}

.page-header h1 {
  margin: 0 0 8px 0;
  font-size: 24px;
  color: #303133;
}

.page-subtitle {
  margin: 0;
  color: #909399;
  font-size: 14px;
}

.vector-tabs {
  background: #fff;
  padding: 20px;
  border-radius: 8px;
  box-shadow: 0 2px 12px 0 rgba(0,0,0,0.05);
}

.custom-tab-label {
  display: flex;
  align-items: center;
  gap: 6px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.box-card {
  margin-bottom: 20px;
}

.search-card {
  margin-top: 20px;
  border-color: #e6a23c;
}

.search-box {
  display: flex;
  gap: 16px;
  margin-bottom: 20px;
}

.search-input {
  flex: 1;
}

.search-options {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

.search-results {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.result-item {
  padding: 12px;
  background: #f8f9fa;
  border-radius: 6px;
  border: 1px solid #ebeef5;
}

.result-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
}

.result-source {
  font-size: 12px;
  color: #909399;
}

.result-content {
  font-size: 14px;
  color: #606266;
  line-height: 1.5;
  max-height: 150px;
  overflow-y: auto;
}

.result-footer {
  margin-top: 8px;
  font-size: 12px;
  color: #999;
  text-align: right;
}

.similarity-result {
  margin-top: 20px;
  text-align: center;
}

.score-circle {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  background: #ecf5ff;
  color: #409eff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: bold;
  margin: 0 auto 10px;
  border: 4px solid #b3d8ff;
}

.score-label {
  color: #909399;
  font-size: 14px;
}

.text-gray {
  color: #909399;
  font-style: italic;
}

/* 文件上传样式 */
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

:deep(.index-tabs .el-tabs__content) {
  padding: 20px;
}
</style>