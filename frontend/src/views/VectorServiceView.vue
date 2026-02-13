<template>
  <div class="vector-service-container">
    <!-- 页面头部 -->
    <div class="page-header">
      <h1>向量知识库</h1>
      <p class="page-subtitle">管理向量数据库、配置 Embedding 模型及相关工具</p>
    </div>

    <el-tabs v-model="activeTab" class="vector-tabs">
      <!-- 向量库管理 Tab：按文件展示，列为各向量化器的索引状态 -->
      <el-tab-pane label="向量库管理" name="store">
        <template #label>
          <span class="custom-tab-label">
            <el-icon><DataLine /></el-icon>
            <span>向量库管理</span>
          </span>
        </template>

        <!-- 当前激活向量化器常驻展示 -->
        <div class="active-vectorizer-bar">
          <span class="bar-label">当前用于新索引的向量化器：</span>
          <template v-if="embeddingDisplay.active_display || embeddingDisplay.active_vectorizer_key">
            <el-tag type="success" size="large">{{ embeddingDisplay.active_display || embeddingDisplay.active_vectorizer_key }}</el-tag>
          </template>
          <template v-else>
            <el-text type="warning">未设置</el-text>
            <el-button type="primary" link size="small" @click="activeTab = 'vectorizers'">请前往「向量化器」添加并激活</el-button>
          </template>
        </div>
        
        <el-card class="box-card" shadow="hover">
          <template #header>
            <div class="card-header">
              <span>文件与向量化器索引状态</span>
              <div class="header-actions">
                <el-select
                  v-model="filterCollection"
                  placeholder="全部集合"
                  clearable
                  size="small"
                  style="width: 140px; margin-right: 8px"
                >
                  <el-option
                    v-for="c in collectionOptions"
                    :key="c"
                    :label="c"
                    :value="c"
                  />
                </el-select>
                <el-button type="primary" size="small" @click="showCreateDialog = true">
                  <el-icon><Plus /></el-icon> 索引新文档
                </el-button>
                <el-button size="small" @click="refreshFileStatus" :loading="loading.collections">
                  <el-icon><Refresh /></el-icon> 刷新
                </el-button>
              </div>
            </div>
          </template>

          <!-- 无向量化器时引导 -->
          <el-alert
            v-if="!loading.collections && fileStatusVectorizers.length === 0 && fileList.length > 0"
            title="尚未配置向量化器"
            type="warning"
            description="请先在「向量化器」Tab 中添加并激活至少一个向量化器，才能为文件建立向量索引。"
            show-icon
            :closable="false"
            style="margin-bottom: 16px"
          >
            <template #default>
              <el-button type="primary" size="small" @click="activeTab = 'vectorizers'">前往向量化器</el-button>
            </template>
          </el-alert>
          
          <el-table :data="filteredFileList" v-loading="loading.collections" style="width: 100%">
            <template #empty>
              <el-empty v-if="fileList.length === 0" description="暂无已索引文件">
                <template #description>
                  <p>请先索引文档，新索引将使用上方「当前用于新索引的向量化器」。</p>
                </template>
                <el-button type="primary" @click="showCreateDialog = true">
                  <el-icon><Plus /></el-icon> 索引新文档
                </el-button>
              </el-empty>
              <el-empty v-else description="当前集合下无文件">
                <p class="empty-tip">尝试切换或清空上方的「集合」筛选</p>
              </el-empty>
            </template>
            <el-table-column prop="file_name" label="文件名称" min-width="180" show-overflow-tooltip />
            <el-table-column prop="collection" label="集合" width="120" show-overflow-tooltip />
            <el-table-column prop="chunk_count" label="文档分块数" width="110" align="center" />
            <el-table-column
              v-for="v in fileStatusVectorizers"
              :key="v.vectorizer_key"
              width="160"
              align="center"
            >
              <template #header>
                <span class="vectorizer-col-header">
                  <span class="header-model" :title="v.model_name">{{ v.model_name }}</span>
                  <el-tag size="small" type="info">{{ v.provider_key }}</el-tag>
                  <el-tag size="small" type="warning">{{ v.dimension }}</el-tag>
                </span>
              </template>
              <template #default="{ row }">
                <el-tag v-if="row.vectorizer_status[v.vectorizer_key] === '已索引'" type="success" size="small">已索引</el-tag>
                <el-button
                  v-else
                  size="small"
                  type="primary"
                  link
                  :loading="indexingFileKey === row.file_id + ':' + v.vectorizer_key"
                  @click="indexFileWithVectorizer(row, v.vectorizer_key)"
                >
                  索引
                </el-button>
              </template>
            </el-table-column>
            <el-table-column label="操作" align="right" width="220" fixed="right">
              <template #default="scope">
                <el-button size="small" @click="openSearchTest(scope.row.collection)">
                  <el-icon><Search /></el-icon> 检索
                </el-button>
                <el-popconfirm
                  title="确定删除该文件？将删除其在所有向量化器下的分块与向量，且不可恢复。"
                  @confirm="handleDeleteFile(scope.row)"
                >
                  <template #reference>
                    <el-button size="small" type="danger">
                      <el-icon><Delete /></el-icon> 删除
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

      <!-- 向量化器 Tab（插件式向量库管理） -->
      <el-tab-pane label="向量化器" name="vectorizers">
        <template #label>
          <span class="custom-tab-label">
            <el-icon><Key /></el-icon>
            <span>向量化器</span>
          </span>
        </template>
        <el-card class="box-card" shadow="hover">
          <template #header>
            <div class="card-header">
              <span>向量化器列表</span>
              <div class="header-actions">
                <el-button type="primary" size="small" @click="showAddVectorizerDialog = true">
                  <el-icon><Plus /></el-icon> 新增向量化器
                </el-button>
                <el-button size="small" @click="refreshVectorizers" :loading="loading.vectorizers">
                  <el-icon><Refresh /></el-icon> 刷新
                </el-button>
              </div>
            </div>
          </template>
          <el-table :data="vectorizers" v-loading="loading.vectorizers" style="width: 100%">
            <template #empty>
              <el-empty description="暂无向量化器">
                <template #description>
                  <p>添加并激活一个向量化器后，即可在「向量库管理」中为文件建立向量索引。</p>
                </template>
                <el-button type="primary" @click="showAddVectorizerDialog = true">
                  <el-icon><Plus /></el-icon> 新增向量化器
                </el-button>
              </el-empty>
            </template>
            <el-table-column prop="vectorizer_key" label="键" min-width="180" show-overflow-tooltip />
            <el-table-column prop="provider_key" label="Provider" width="120" />
            <el-table-column prop="model_name" label="模型" min-width="140" show-overflow-tooltip />
            <el-table-column prop="vector_dimension" label="维度" width="80" align="center" />
            <el-table-column prop="vector_count" label="文档数" width="90" align="center" />
            <el-table-column label="激活" width="80" align="center">
              <template #default="{ row }">
                <el-tag v-if="row.is_active" type="success" size="small">当前</el-tag>
                <el-button v-else size="small" type="primary" link @click="handleActivateVectorizer(row.vectorizer_key)">激活</el-button>
              </template>
            </el-table-column>
            <el-table-column label="操作" align="right" width="100" fixed="right">
              <template #default="{ row }">
                <el-popconfirm title="确定删除该向量化器？将同时删除其向量数据。" @confirm="handleDeleteVectorizer(row.vectorizer_key)">
                  <template #reference>
                    <el-button size="small" type="danger" link>删除</el-button>
                  </template>
                </el-popconfirm>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <!-- 新增向量化器对话框 -->
        <el-dialog v-model="showAddVectorizerDialog" title="新增向量化器" width="480px" @close="addVectorizerForm.provider_key = ''; addVectorizerForm.model_name = ''">
          <el-form :model="addVectorizerForm" label-width="100px">
            <el-form-item label="Provider">
              <el-select v-model="addVectorizerForm.provider_key" placeholder="选择 Provider" style="width: 100%" filterable @change="onAddFormProviderChange">
                <el-option v-for="p in availableProviders" :key="p.key" :label="p.name + ' (' + p.provider_type + ')'" :value="p.key" />
              </el-select>
            </el-form-item>
            <el-form-item label="模型名称">
              <el-select v-model="addVectorizerForm.model_name" placeholder="选择或输入模型" style="width: 100%" filterable allow-create>
                <el-option v-if="addFormRecommendedModel" :label="addFormRecommendedModel + ' (推荐)'" :value="addFormRecommendedModel" />
                <el-option v-for="m in addFormModelList" :key="m" :label="m" :value="m" />
              </el-select>
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="showAddVectorizerDialog = false">取消</el-button>
            <el-button type="primary" :loading="loading.addVectorizer" @click="submitAddVectorizer">确定</el-button>
          </template>
        </el-dialog>
      </el-tab-pane>

      <!-- Embedding 配置 Tab（只读展示，引导到向量化器） -->
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
            </div>
          </template>
          <el-alert
            title="向量化器已迁移到「向量库管理」"
            type="info"
            :closable="false"
            show-icon
            style="margin-bottom: 16px"
          >
            <template #default>
              <p>请在 <strong>「向量化器」</strong> Tab 中管理多套向量化器、激活当前使用的模型，以及迁移、删除等操作。</p>
              <p v-if="embeddingDisplay.active_vectorizer_key" style="margin-top: 8px;">
                当前激活: <el-tag type="success">{{ embeddingDisplay.active_display || embeddingDisplay.active_vectorizer_key }}</el-tag>
              </p>
              <el-button type="primary" size="small" style="margin-top: 12px" @click="activeTab = 'vectorizers'">前往向量化器</el-button>
            </template>
          </el-alert>
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
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { 
  DataLine, Setting, Refresh, Search, Delete, 
  Link, Key, Cpu, Check, Tools, Plus, View, Upload, UploadFilled 
} from '@element-plus/icons-vue'
import { getCollections, deleteCollection, searchVectors, indexFileUpload, indexDocument as apiIndexDocument } from '@/api/vectorService'
import { getConfig, getRawConfig, updateConfig } from '@/api/config'
import * as vectorLibrary from '@/api/vectorLibrary'
import { modelAdapterService } from '@/api'
import { listFiles } from '@/api/fileService'

defineOptions({ name: 'VectorServiceView' })

const activeTab = ref('store')

// 状态
const loading = reactive({
  collections: false,
  search: false,
  saving: false,
  similarity: false,
  vectorizers: false,
  addVectorizer: false
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

// 向量库数据：文件维度 + 各向量化器索引状态
const fileList = ref([])
const fileStatusVectorizers = ref([])
const indexingFileKey = ref('') // 'file_id:vectorizer_key' 正在索引时不为空
const filterCollection = ref('') // 按集合筛选
const collections = ref([])
const currentCollection = ref(null)
const searchQuery = ref('')
const searchTopK = ref(5)
const searchResults = ref([])
const searchPerformed = ref(false)

// Embedding 配置数据（仅用于兼容旧接口返回；实际以向量化器为准）
const config = reactive({
  embedding: {
    provider: '',
    provider_type: '',
    model_name: '',
    batch_size: 100
  }
})

// 向量化器相关
const vectorizers = ref([])
const showAddVectorizerDialog = ref(false)
const addVectorizerForm = reactive({ provider_key: '', model_name: '' })
const addFormRecommendedModel = ref('')
const addFormModelList = ref([])
const embeddingDisplay = reactive({ source: 'vector_library', active_vectorizer_key: null, message: '', active_display: null })

// 集合筛选选项（从文件列表去重）
const collectionOptions = computed(() => {
  const set = new Set(fileList.value.map((f) => f.collection).filter(Boolean))
  return [...set].sort()
})
// 按集合筛选后的文件列表
const filteredFileList = computed(() => {
  if (!filterCollection.value) return fileList.value
  return fileList.value.filter((f) => f.collection === filterCollection.value)
})

// 当前选中的 Provider 复合键（用于下拉框 v-model，便于唯一匹配）
const embeddingProviderKey = computed({
  get() {
    const p = config.embedding.provider
    const t = config.embedding.provider_type
    if (t) return `${p}_${t}`
    return p || ''
  },
  set(key) {
    if (!key) {
      config.embedding.provider = ''
      config.embedding.provider_type = ''
      return
    }
    const provider = availableProviders.value.find((x) => x.key === key)
    if (provider) {
      config.embedding.provider = provider.name
      config.embedding.provider_type = provider.provider_type
    }
  }
})

// 加载 Provider 列表
const loadProviders = async () => {
  try {
    const res = await modelAdapterService.getProviders()
    if (res.success) {
      // 包含embedding模型的 Provider 列表
      availableProviders.value = res.providers.filter(p => {
        const emb = p.model_map?.embedding
        const hasEmbedding = emb != null && (Array.isArray(emb) ? emb.length > 0 : String(emb).trim())
        return (p.models?.length > 0) || hasEmbedding
      })
      
      // 如果已选择 provider，加载其模型（传复合键）
      const key = config.embedding.provider_type
        ? `${config.embedding.provider}_${config.embedding.provider_type}`
        : config.embedding.provider
      if (key) {
        handleProviderChange(key)
      }
    }
  } catch (error) {
    ElMessage.error('加载 Provider 列表失败')
  }
}

// 处理 Provider 变更（传入复合键 provider.key 或旧版仅 name）
const handleProviderChange = (keyOrName) => {
  const provider = availableProviders.value.find(
    (p) => (p.key && p.key === keyOrName) || p.name === keyOrName
  )
  if (provider) {
    config.embedding.provider = provider.name
    config.embedding.provider_type = provider.provider_type || ''
    // 重置模型列表
    // 从 model_map 和 models (兼容旧版) 中收集所有模型
    const allModels = new Set(provider.models || [])
    if (provider.model_map) {
      Object.values(provider.model_map).forEach(m => {
        if (Array.isArray(m)) {
          m.forEach((x) => { if (x && String(x).trim()) allModels.add(String(x).trim()) })
        } else if (m && String(m).trim()) {
          allModels.add(String(m).trim())
        }
      })
    }
    currentProviderModels.list = Array.from(allModels)
    const emb = provider.model_map?.embedding
    currentProviderModels.embedding = Array.isArray(emb) ? (emb[0] || '') : (emb || '')
    
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

// 方法：加载文件维度索引状态（向量库主表）
// 删除文件（所有向量化器下的分块与向量）
const handleDeleteFile = async (row) => {
  try {
    const res = await vectorLibrary.deleteFile({
      collection: row.collection,
      file_id: row.file_id
    })
    if (res.success) {
      ElMessage.success(`已删除，共 ${res.data?.deleted_chunks ?? 0} 个分块`)
      await refreshFileStatus()
    } else {
      ElMessage.error(res.message || '删除失败')
    }
  } catch (e) {
    ElMessage.error('删除失败: ' + (e.response?.data?.message || e.message || e))
  }
}

// 使用指定向量化器对单文件建索引
const indexFileWithVectorizer = async (row, vectorizerKey) => {
  const key = row.file_id + ':' + vectorizerKey
  indexingFileKey.value = key
  try {
    const res = await vectorLibrary.indexFileWithVectorizer({
      collection: row.collection,
      file_id: row.file_id,
      vectorizer_key: vectorizerKey
    })
    if (res.success) {
      ElMessage.success(`已用该向量化器索引 ${res.data?.indexed_count ?? 0} 个分块`)
      await refreshFileStatus()
    } else {
      ElMessage.error(res.message || '索引失败')
    }
  } catch (e) {
    ElMessage.error('索引失败: ' + (e.response?.data?.message || e.message || e))
  } finally {
    indexingFileKey.value = ''
  }
}

const refreshFileStatus = async () => {
  loading.collections = true
  try {
    const res = await vectorLibrary.getFileStatus()
    if (res.success && res.data) {
      fileList.value = res.data.files || []
      fileStatusVectorizers.value = res.data.vectorizers || []
    } else {
      fileList.value = []
      fileStatusVectorizers.value = []
    }
    await loadConfig()
  } catch (error) {
    const msg = error.response?.data?.message || error.message || error
    ElMessage.error('获取文件状态失败: ' + msg)
    fileList.value = []
    fileStatusVectorizers.value = []
  } finally {
    loading.collections = false
  }
}

// 方法：删除集合（保留供检索区等使用）
const handleDeleteCollection = async (name) => {
  try {
    const res = await deleteCollection(name)
    if (res.success) {
      ElMessage.success('删除成功')
      refreshFileStatus()
      if (currentCollection.value === name) {
        currentCollection.value = null
      }
    } else {
      ElMessage.error(res.message || res.error || '删除失败')
    }
  } catch (error) {
    ElMessage.error('删除失败: ' + (error.response?.data?.message || error.message || error))
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
      ElMessage.error(res.message || res.error || '检索失败')
    }
  } catch (error) {
    ElMessage.error('检索失败: ' + (error.response?.data?.message || error.message || error))
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
      refreshFileStatus()
      resetIndexForm()
    }
  } catch (error) {
    ElMessage.error('索引失败: ' + (error.response?.data?.message || error.response?.data?.error || error.message || error))
  } finally {
    indexing.value = false
  }
}

// 方法：加载配置（当前仅用于展示；向量化器以「向量化器」Tab 的 API 为准）
const loadConfig = async () => {
  try {
    const res = await getConfig()
    if (res.success && res.data && res.data.embedding) {
      const emb = res.data.embedding
      if (emb.source === 'vector_library') {
        embeddingDisplay.source = 'vector_library'
        embeddingDisplay.active_vectorizer_key = emb.active_vectorizer_key || null
        embeddingDisplay.message = emb.message || ''
        embeddingDisplay.active_display = emb.active_display || null
      }
    }
    await loadProviders()
  } catch (error) {
    console.error('加载配置错误:', error)
  }
}

// 方法：保存配置（向量化器已迁移，此处不再保存 embedding）
const saveConfig = async () => {
  ElMessage.info('向量化器请在「向量化器」Tab 中管理')
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

// ---------- 向量化器 Tab 方法 ----------
const refreshVectorizers = async () => {
  loading.vectorizers = true
  try {
    const res = await vectorLibrary.listVectorizers()
    if (res.success && res.data) {
      vectorizers.value = Array.isArray(res.data) ? res.data : []
    } else {
      vectorizers.value = []
    }
  } catch (e) {
    ElMessage.error('加载向量化器列表失败: ' + (e.message || e))
    vectorizers.value = []
  } finally {
    loading.vectorizers = false
  }
}

const handleActivateVectorizer = async (key) => {
  try {
    const res = await vectorLibrary.activateVectorizer(key)
    if (res.success) {
      ElMessage.success('已切换激活向量化器')
      refreshVectorizers()
      loadConfig()
    } else {
      ElMessage.error(res.message || '激活失败')
    }
  } catch (e) {
    ElMessage.error('激活失败: ' + (e.response?.data?.message || e.message || e))
  }
}

const handleDeleteVectorizer = async (key) => {
  try {
    const res = await vectorLibrary.deleteVectorizer(key)
    if (res.success) {
      ElMessage.success('已删除向量化器')
      refreshVectorizers()
      loadConfig()
    } else {
      ElMessage.error(res.message || '删除失败')
    }
  } catch (e) {
    ElMessage.error('删除失败: ' + (e.response?.data?.message || e.message || e))
  }
}

const onAddFormProviderChange = (providerKey) => {
  const p = availableProviders.value.find((x) => x.key === providerKey)
  if (p) {
    const emb = p.model_map?.embedding
    addFormRecommendedModel.value = Array.isArray(emb) ? (emb[0] || '') : (emb || '')
    const allModels = new Set(p.models || [])
    if (p.model_map) {
      Object.values(p.model_map).forEach(m => {
        if (Array.isArray(m)) m.forEach((x) => { if (x && String(x).trim()) allModels.add(String(x).trim()) })
        else if (m && String(m).trim()) allModels.add(String(m).trim())
      })
    }
    addFormModelList.value = Array.from(allModels)
    if (!addVectorizerForm.model_name && addFormRecommendedModel.value) {
      addVectorizerForm.model_name = addFormRecommendedModel.value
    }
  } else {
    addFormRecommendedModel.value = ''
    addFormModelList.value = []
  }
}

const submitAddVectorizer = async () => {
  if (!addVectorizerForm.provider_key || !addVectorizerForm.model_name) {
    ElMessage.warning('请选择 Provider 和模型名称')
    return
  }
  loading.addVectorizer = true
  try {
    const res = await vectorLibrary.addVectorizer({
      provider_key: addVectorizerForm.provider_key,
      model_name: addVectorizerForm.model_name.trim()
    })
    if (res.success) {
      ElMessage.success('已添加向量化器')
      showAddVectorizerDialog.value = false
      addVectorizerForm.provider_key = ''
      addVectorizerForm.model_name = ''
      refreshVectorizers()
      loadConfig()
    } else {
      ElMessage.error(res.message || '添加失败')
    }
  } catch (e) {
    ElMessage.error('添加失败: ' + (e.response?.data?.message || e.message || e))
  } finally {
    loading.addVectorizer = false
  }
}

onMounted(() => {
  refreshFileStatus()
  loadConfig()
  refreshVectorizers()
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

.active-vectorizer-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  margin-bottom: 16px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  font-size: 14px;
}
.active-vectorizer-bar .bar-label {
  color: var(--el-text-color-regular);
}
.empty-tip {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
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

.vectorizer-col-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.vectorizer-col-header .header-model {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.vectorizer-col-header .el-tag {
  margin: 0 2px;
}
</style>