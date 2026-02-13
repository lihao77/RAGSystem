<template>
  <div class="llm-adapter-container">
    <!-- 页面头部 -->
    <div class="page-header">
      <h1>Model Adapter 配置</h1>
      <p>统一管理和配置大语言模型及 Embedding 服务</p>
    </div>

    <!-- 操作栏 -->
    <div class="action-bar">
      <el-button type="primary" @click="showAddProviderDialog">
        <el-icon><Plus /></el-icon> 添加 Provider
      </el-button>
      <el-button @click="loadProviders">
        <el-icon><Refresh /></el-icon> 刷新
      </el-button>
      <el-button @click="testAllProviders">
        <el-icon><Connection /></el-icon> 测试所有
      </el-button>
    </div>
    
    <!-- 提示信息 -->
    <el-alert 
      type="info" 
      :closable="false" 
      style="margin: 10px 0;">
      <template #title>
        <span>💡 提示：可以创建同名但不同类型的 Provider，例如 <code>test_deepseek</code> 和 <code>test_openrouter</code></span>
      </template>
    </el-alert>

    <!-- Provider 列表 -->
    <div class="provider-list">
      <el-card v-for="provider in providers" :key="provider.key" class="provider-card">
        <template #header>
          <div class="provider-header">
            <div class="provider-info">
              <h3>{{ provider.name }}</h3>
              <el-tag :type="getProviderTypeTag(provider.provider_type)">
                {{ provider.provider_type }}
              </el-tag>
            </div>
            <div class="provider-actions">
              <el-button size="small" @click="testProvider(provider.key)">
                测试
              </el-button>
              <el-button size="small" type="primary" @click="showEditProviderDialog(provider)">
                编辑
              </el-button>
              <el-button size="small" type="danger" @click="deleteProvider(provider.key)">
                删除
              </el-button>
            </div>
          </div>
        </template>

        <div class="provider-details">
          <div class="detail-row">
            <span class="label">模型映射:</span>
            <div class="model-map-tags">
               <template v-if="provider.model_map && Object.keys(provider.model_map).length > 0">
                 <div v-for="(model, task) in provider.model_map" :key="task" class="model-map-item">
                   <el-tag size="small" type="info">{{ task }}</el-tag>
                   <span class="arrow">→</span>
                   <template v-if="Array.isArray(model)">
                     <el-tag v-for="(m, i) in model" :key="i" size="small" effect="plain">{{ m }}</el-tag>
                   </template>
                   <el-tag v-else size="small" effect="plain">{{ model }}</el-tag>
                 </div>
               </template>
               <span v-else class="value" style="color: #909399">
                 默认模型: {{ provider.model || '未配置' }}
               </span>
            </div>
          </div>
          <div class="detail-row">
            <span class="label">温度:</span>
            <span class="value">{{ provider.temperature }}</span>
          </div>
          <div class="detail-row">
            <span class="label">最大Token:</span>
            <span class="value">{{ provider.max_tokens }}</span>
          </div>
          <div class="detail-row">
            <span class="label">超时:</span>
            <span class="value">{{ provider.timeout }}s</span>
          </div>
          <div class="detail-row">
            <span class="label">支持工具调用:</span>
            <el-tag :type="provider.supports_function_calling ? 'success' : 'info'" size="small">
              {{ provider.supports_function_calling ? '是' : '否' }}
            </el-tag>
          </div>
        </div>
      </el-card>
    </div>

    <!-- 添加/编辑 Provider 对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="600px"
      :close-on-click-modal="false"
    >
      <el-form :model="formData" :rules="formRules" ref="formRef" label-width="120px">
        <template v-if="currentProvider">
          <el-form-item label="Provider 类型">
            <el-tag :type="getProviderTypeTag(formData.provider_type)">
              {{ formData.provider_type }}
            </el-tag>
            <div style="font-size: 12px; color: #999; margin-top: 5px;">
              提供商类型不支持修改
            </div>
          </el-form-item>

          <el-form-item label="名称">
            <el-input :value="formData.name" disabled />
            <div style="font-size: 12px; color: #999; margin-top: 5px;">
              名称不支持修改
            </div>
          </el-form-item>

          <el-form-item label="API Key">
            <el-input
              :value="'******'"
              disabled
            />
            <div style="font-size: 12px; color: #999; margin-top: 5px;">
              API Key 不支持修改（出于安全原因）
            </div>
          </el-form-item>

          <el-form-item label="API 端点">
            <el-input :value="formData.api_endpoint" disabled />
            <div style="font-size: 12px; color: #999; margin-top: 5px;">
              API 端点不支持修改
            </div>
          </el-form-item>
        </template>

        <template v-else>
          <el-form-item label="Provider 类型" prop="provider_type">
            <el-select v-model="formData.provider_type" placeholder="请选择 Provider 类型">
              <el-option label="OpenAI" value="openai" />
              <el-option label="DeepSeek" value="deepseek" />
              <el-option label="OpenRouter" value="openrouter" />
              <el-option label="ModelScope" value="modelscope" />
            </el-select>
          </el-form-item>

          <el-form-item label="名称" prop="name">
            <el-input v-model="formData.name" placeholder="输入 Provider 名称" />
          </el-form-item>

          <el-form-item label="API Key" prop="api_key">
            <el-input
              v-model="formData.api_key"
              type="password"
              show-password
              placeholder="输入 API Key"
            />
            <div style="font-size: 12px; color: #999; margin-top: 5px;">
              请妥善保管您的 API 密钥
            </div>
          </el-form-item>

          <el-form-item label="API 端点" prop="api_endpoint">
            <el-input v-model="formData.api_endpoint" :placeholder="getDefaultEndpoint()" />
          </el-form-item>
        </template>

        <!-- 模型映射配置：每项为模型列表，第一个为默认使用 -->
        <el-divider>模型映射配置</el-divider>
        <el-form-item label="Chat 模型">
          <el-select
            v-model="formData.model_map.chat"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="输入后回车添加，或粘贴逗号分隔的多个模型"
            style="width: 100%"
            @paste="(e) => pasteModels(e, 'chat')"
          >
            <el-option v-for="m in (formData.model_map.chat || [])" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>
        <el-form-item label="Embedding 模型">
          <el-select
            v-model="formData.model_map.embedding"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="输入后回车添加，或粘贴逗号分隔的多个模型"
            style="width: 100%"
            @paste="(e) => pasteModels(e, 'embedding')"
          >
            <el-option v-for="m in (formData.model_map.embedding || [])" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>
        <el-form-item label="Reasoning 模型">
          <el-select
            v-model="formData.model_map.reasoning"
            multiple
            filterable
            allow-create
            default-first-option
            placeholder="输入后回车添加，或粘贴逗号分隔的多个模型"
            style="width: 100%"
            @paste="(e) => pasteModels(e, 'reasoning')"
          >
            <el-option v-for="m in (formData.model_map.reasoning || [])" :key="m" :label="m" :value="m" />
          </el-select>
        </el-form-item>
        <el-divider></el-divider>

        <!-- 已移除 models 列表配置 -->

        <el-collapse>
          <el-collapse-item title="高级选项" name="advanced">
            <el-form-item label="温度">
              <el-slider v-model="formData.temperature" :min="0" :max="2" :step="0.1" />
            </el-form-item>

            <el-form-item label="最大Token">
              <el-input-number v-model="formData.max_tokens" :min="1" :max="32000" />
            </el-form-item>

            <el-form-item label="超时时间(秒)">
              <el-input-number v-model="formData.timeout" :min="1" :max="300" />
            </el-form-item>

            <el-form-item label="重试次数">
              <el-input-number v-model="formData.retry_attempts" :min="0" :max="10" />
            </el-form-item>

            <el-form-item label="支持工具调用">
              <el-switch v-model="formData.supports_function_calling" />
            </el-form-item>
          </el-collapse-item>
        </el-collapse>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">确定</el-button>
      </template>
    </el-dialog>

    <!-- API 测试对话框 -->
    <el-dialog
      v-model="testDialogVisible"
      title="API 测试"
      width="700px"
    >
      <div class="api-test">
        <el-form label-width="80px">
          <el-form-item label="Provider" v-if="currentProvider">
            <h3>{{ currentProviderObj?.name || currentProvider }}</h3>
            
          </el-form-item>
          <el-form-item label="Type" v-if="currentProvider">
            <el-tag
              v-if="currentProviderObj?.provider_type"
              :type="getProviderTypeTag(currentProviderObj.provider_type)"
              size="small"
            >
              {{ currentProviderObj.provider_type }}
            </el-tag>
          </el-form-item>

          <el-form-item label="测试任务">
             <el-radio-group v-model="testTask">
               <el-radio label="chat">对话 (Chat)</el-radio>
               <el-radio label="embedding">向量化 (Embedding)</el-radio>
             </el-radio-group>
          </el-form-item>

          <el-form-item label="选择模型" v-if="currentProvider" required>
            <template v-if="currentProviderObj?.model_map && getTestModelOptions(currentProviderObj).length > 0">
              <el-select
                v-model="testModel"
                placeholder="选择或输入模型名称"
                style="width: 100%"
                filterable
                allow-create
                default-first-option
              >
                <el-option-group label="配置模型">
                  <el-option
                    v-for="m in getTestModelOptions(currentProviderObj)"
                    :key="m.value"
                    :label="m.label"
                    :value="m.value"
                  />
                </el-option-group>
              </el-select>
              <div style="font-size: 12px; color: #999; margin-top: 5px;">
                可以从列表选择，也可以输入不在列表中的模型名称
              </div>
              
              <div 
                v-if="testTask === 'embedding' && !testModel && !getModelsList(currentProviderObj?.model_map, 'embedding').length"
                style="color: #e6a23c; font-size: 12px; margin-top: 5px;"
              >
                <el-icon><Warning /></el-icon> 未配置默认 Embedding 模型，请手动输入或选择
              </div>
              <div 
                v-if="testTask === 'embedding' && testModel && getModelsList(currentProviderObj?.model_map, 'chat').includes(testModel)"
                style="color: #f56c6c; font-size: 12px; margin-top: 5px;"
              >
                <el-icon><Warning /></el-icon> 警告：您选择了 Chat 模型用于向量化任务，可能导致调用失败
              </div>
            </template>
            <template v-else>
              <el-input
                v-model="testModel"
                placeholder="输入模型名称"
                clearable
              />
              <div style="font-size: 12px; color: #999; margin-top: 5px;">
                自由输入模型名称（该 Provider 未配置模型列表）
              </div>
            </template>
          </el-form-item>
          <el-form-item label="输入内容">
            <el-input
              v-model="testPrompt"
              type="textarea"
              :rows="3"
              placeholder="输入测试提示词或文本"
            />
          </el-form-item>
          <el-button type="primary" @click="runTest" :loading="testLoading">
            运行测试
          </el-button>
        </el-form>

        <div v-if="testResult" class="test-result">
          <el-divider>测试结果</el-divider>
          <el-descriptions :column="2" border>
            <el-descriptions-item label="状态">
              <el-tag :type="testResult.error ? 'danger' : 'success'">
                {{ testResult.error ? '失败' : '成功' }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="延迟">
              {{ testResult.latency ? testResult.latency.toFixed(2) + 's' : '-' }}
            </el-descriptions-item>
            
            <template v-if="testTask === 'chat'">
                <el-descriptions-item label="Token 使用" :span="2">
                  <div v-if="testResult.usage">
                    输入: {{ testResult.usage.prompt_tokens }} |
                    输出: {{ testResult.usage.completion_tokens }} |
                    总计: {{ testResult.usage.total_tokens }}
                  </div>
                  <div v-else>-</div>
                </el-descriptions-item>
                <el-descriptions-item label="成本" :span="2">
                  ${{ testResult.cost ? testResult.cost.toFixed(6) : '0.000000' }}
                </el-descriptions-item>
            </template>
            <template v-else>
                 <el-descriptions-item label="维度" :span="2">
                   {{ testResult.embeddings ? testResult.embeddings[0]?.length : '-' }}
                 </el-descriptions-item>
            </template>
          </el-descriptions>

          <el-divider>响应内容</el-divider>
          <el-input
            v-if="testTask === 'chat'"
            v-model="testResult.content"
            type="textarea"
            :rows="6"
            readonly
          />
          <div v-else style="max-height: 200px; overflow-y: auto;">
             <pre>{{ JSON.stringify(testResult.embeddings ? testResult.embeddings[0].slice(0, 5) : [], null, 2) }} ... (truncated)</pre>
          </div>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Connection, Warning } from '@element-plus/icons-vue'
import { modelAdapterService } from '@/api' // 修改引入

// 数据
const providers = ref([])
const dialogVisible = ref(false)
const testDialogVisible = ref(false)
const dialogTitle = ref('添加 Provider')
const testPrompt = ref('你好，请介绍一下自己')
const testResult = ref(null)
const testLoading = ref(false)
const testModel = ref('')
const testTask = ref('chat') // chat | embedding
const formRef = ref(null)
const currentProvider = ref(null)

// 计算当前 Provider 对象（使用 key 或 name 查找）
const currentProviderObj = computed(() => {
  if (!currentProvider.value) return null
  return providers.value.find(p => 
    (p.key && p.key === currentProvider.value) || 
    p.name === currentProvider.value
  )
})

// 表单数据
const formData = ref({
  provider_type: 'openai',
  name: '',
  api_key: '',
  api_endpoint: '',
  models: [],
  model_map: { chat: [], embedding: [], reasoning: [] },
  temperature: 0.7,
  max_tokens: 4096,
  timeout: 30,
  retry_attempts: 3,
  supports_function_calling: true
})

// 动态表单验证规则
const formRules = computed(() => {
  if (currentProvider.value) {
    // 编辑模式：不验证任何必填字段（所有字段都是可选的）
    return {}
  } else {
    // 添加模式：验证关键字段
    return {
      provider_type: [{ required: true, message: '请选择 Provider 类型', trigger: 'change' }],
      name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
      api_key: [{ required: true, message: '请输入 API Key', trigger: 'blur' }]
    }
  }
})

// 默认端点
const defaultEndpoints = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  modelscope: 'https://api-inference.modelscope.cn/v1'
}

// 方法
const getDefaultEndpoint = () => {
  return defaultEndpoints[formData.value.provider_type] || ''
}

const loadProviders = async () => {
  try {
    const res = await modelAdapterService.getProviders()
    providers.value = res.providers || []
  } catch (error) {
    ElMessage.error('加载 Provider 列表失败')
  }
}

const getProviderTypeTag = (type) => {
  const tags = {
    openai: 'primary',
    deepseek: 'warning',
    openrouter: 'success',
    modelscope: 'danger'
  }
  return tags[type] || 'info'
}

// 将 model_map 值规范为数组（兼容后端返回字符串或数组）
const normalizeModelMap = (modelMap) => {
  if (!modelMap || typeof modelMap !== 'object') return { chat: [], embedding: [], reasoning: [] }
  const toList = (v) => {
    if (v == null || v === '') return []
    if (Array.isArray(v)) return v.filter(Boolean).map((s) => String(s).trim())
    return [String(v).trim()]
  }
  return {
    chat: toList(modelMap.chat),
    embedding: toList(modelMap.embedding),
    reasoning: toList(modelMap.reasoning)
  }
}

// 粘贴时按逗号拆分并加入当前项列表
const pasteModels = (e, key) => {
  const text = (e.clipboardData || window.clipboardData)?.getData('text') || ''
  if (!text || !text.includes(',')) return
  e.preventDefault()
  const list = formData.value.model_map[key] || []
  const added = text.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  const set = new Set([...list, ...added])
  formData.value.model_map[key] = [...set]
}

// 从 model_map 取某任务的模型列表（兼容字符串/数组）
const getModelsList = (modelMap, task) => {
  if (!modelMap || !task) return []
  const v = modelMap[task]
  if (v == null || v === '') return []
  return Array.isArray(v) ? v.filter(Boolean) : [String(v)]
}

// 测试对话框中的模型下拉选项（按任务分组展示）
const getTestModelOptions = (provider) => {
  if (!provider?.model_map) return []
  const opts = []
  const tasks = [
    { key: 'chat', label: 'Chat' },
    { key: 'embedding', label: 'Embedding' },
    { key: 'reasoning', label: 'Reasoning' }
  ]
  tasks.forEach(({ key, label }) => {
    getModelsList(provider.model_map, key).forEach((m) => {
      opts.push({ value: m, label: `${m} (${label})` })
    })
  })
  return opts
}

// 处理模型列表
const getModelList = (models) => {
  if (!models || models.length === 0) return []
  return models
}

const showAddProviderDialog = () => {
  dialogTitle.value = '添加 Provider'
  currentProvider.value = null
  formData.value = {
    provider_type: 'openai',
    name: '',
    api_key: '',
    api_endpoint: '',
    model_map: { chat: [], embedding: [], reasoning: [] },
    temperature: 0.7,
    max_tokens: 4096,
    timeout: 30,
    retry_attempts: 3,
    supports_function_calling: true
  }
  dialogVisible.value = true
}

const showEditProviderDialog = (provider) => {
  dialogTitle.value = '编辑 Provider'
  // 优先使用 key，fallback 到 name（向后兼容）
  currentProvider.value = provider.key || provider.name

  formData.value = {
    provider_type: provider.provider_type,
    name: provider.name,
    api_endpoint: provider.api_endpoint || '',
    model_map: normalizeModelMap(provider.model_map),
    temperature: provider.temperature || 0.7,
    max_tokens: provider.max_tokens || 4096,
    timeout: provider.timeout || 30,
    retry_attempts: provider.retry_attempts || 3,
    supports_function_calling: provider.supports_function_calling !== false
  }
  dialogVisible.value = true
}

const submitForm = async () => {
  if (!formRef.value) return

  await formRef.value.validate(async (valid) => {
    if (!valid) return

    // model_map 已为列表，提交前过滤空字符串
    const modelMap = {}
    for (const [k, v] of Object.entries(formData.value.model_map || {})) {
      modelMap[k] = Array.isArray(v) ? v.filter((s) => s && String(s).trim()) : (v ? [String(v).trim()] : [])
    }

    const baseData = {
      models: [...new Set(Object.values(modelMap).flat())],
      model_map: modelMap,
      temperature: formData.value.temperature,
      max_tokens: formData.value.max_tokens,
      timeout: formData.value.timeout,
      retry_attempts: formData.value.retry_attempts,
      supports_function_calling: formData.value.supports_function_calling
    }

    try {
      if (currentProvider.value) {
        // 编辑模式：只能修改模型列表和高级选项
        const submitData = {
          ...baseData,
          provider_type: formData.value.provider_type,
          name: formData.value.name,
          // 不包含 api_key 和 api_endpoint
        }
        // 使用 provider_key 调用更新 API
        await modelAdapterService.updateProvider(currentProvider.value, submitData)
        ElMessage.success('更新成功')
      } else {
        // 添加模式：可以修改所有字段
        const submitData = {
          ...baseData,
          provider_type: formData.value.provider_type,
          name: formData.value.name,
          api_key: formData.value.api_key,
          api_endpoint: formData.value.api_endpoint || ''
        }
        await modelAdapterService.createProvider(submitData)
        ElMessage.success('添加成功')
      }

      dialogVisible.value = false
      loadProviders()
    } catch (error) {
      ElMessage.error(currentProvider.value ? '更新失败' : '添加失败')
    }
  })
}

const deleteProvider = async (providerKey) => {
  try {
    await ElMessageBox.confirm(`确定要删除 ${providerKey} 吗？`, '确认删除', {
      type: 'warning'
    })

    await modelAdapterService.deleteProvider(providerKey)
    ElMessage.success('删除成功')
    loadProviders()
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('删除失败')
    }
  }
}

const setActiveProvider = async (name) => {
  try {
    await modelAdapterService.setActiveProvider(name)
    ElMessage.success('设置成功')
    loadProviders()
  } catch (error) {
    ElMessage.error('设置失败')
  }
}

const testProvider = (providerKey) => {
  currentProvider.value = providerKey
  testModel.value = ''
  testResult.value = null
  testPrompt.value = '你好，请介绍一下自己'
  testTask.value = 'chat'
  testDialogVisible.value = true
  
  const provider = providers.value.find(p => (p.key || p.name) === providerKey)
  const chatModels = getModelsList(provider?.model_map, 'chat')
  testModel.value = chatModels.length ? chatModels[0] : ''
}

const testAllProviders = () => {
  currentProvider.value = null
  testResult.value = null
  testPrompt.value = '你好，请介绍一下自己'
  testTask.value = 'chat'
  testDialogVisible.value = true
}

const runTest = async () => {
  if (!testPrompt.value.trim()) {
    ElMessage.warning('请输入内容')
    return
  }

  if (!testModel.value && currentProvider.value) {
    ElMessage.warning('请选择要测试的模型')
    return
  }

  testLoading.value = true
  testResult.value = null

  try {
    const p = currentProviderObj.value
    const testParams = {
      provider: p?.name ?? currentProvider.value,
      provider_type: p?.provider_type,
      prompt: testPrompt.value,
      task: testTask.value
    }
    if (testModel.value) testParams.model = testModel.value

    const res = await modelAdapterService.testProvider(testParams)
    testResult.value = res.response
  } catch (error) {
    ElMessage.error('测试失败')
  } finally {
    testLoading.value = false
  }
}

// 监听 testTask 变化，自动切换默认模型
watch(testTask, (newTask) => {
    if (currentProviderObj.value && currentProviderObj.value.model_map) {
        if (newTask === 'chat') {
            testModel.value = currentProviderObj.value.model_map.chat || ''
        } else if (newTask === 'embedding') {
            testModel.value = currentProviderObj.value.model_map.embedding || ''
        }
    }
})

// 生命周期
onMounted(() => {
  loadProviders()
})
</script>

<style scoped>
.llm-adapter-container {
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

.page-header p {
  margin: 0;
  color: #606266;
  font-size: 14px;
}

.action-bar {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
  align-items: center;
}

.provider-list {
  display: grid;
  gap: 20px;
}

.provider-card {
  transition: all 0.3s;
}

.provider-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.provider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.provider-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.provider-info h3 {
  margin: 0;
  font-size: 16px;
  color: #303133;
}

.provider-actions {
  display: flex;
  gap: 8px;
}

.provider-details {
  margin-bottom: 20px;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}

.detail-row:last-child {
  border-bottom: none;
}

.detail-row .label {
  color: #606266;
  font-size: 14px;
  white-space: nowrap;
  margin-right: 12px;
}

.detail-row .value {
  color: #303133;
  font-size: 14px;
  font-weight: 500;
}

.model-map-tags {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-end;
}

.model-map-item {
    display: flex;
    align-items: center;
    gap: 4px;
}

.arrow {
    color: #909399;
    font-size: 12px;
}

.api-test {
  max-height: 60vh;
  overflow-y: auto;
}

.test-result {
  margin-top: 20px;
}

:deep(.el-dialog__body) {
  padding-top: 10px;
}
</style>
