<template>
  <div class="llm-adapter-container">
    <!-- 页面头部 -->
    <div class="page-header">
      <h1>LLM Adapter 配置</h1>
      <p>统一管理和配置大语言模型服务</p>
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
      <el-select v-model="loadBalancer" @change="updateLoadBalancer" style="margin-left: auto; width: 200px">
        <el-option label="轮询模式" value="round_robin" />
        <el-option label="随机模式" value="random" />
      </el-select>
    </div>

    <!-- Provider 列表 -->
    <div class="provider-list">
      <el-card v-for="provider in providers" :key="provider.name" class="provider-card">
        <template #header>
          <div class="provider-header">
            <div class="provider-info">
              <h3>{{ provider.name }}</h3>
              <el-tag :type="getProviderTypeTag(provider.provider_type)">
                {{ provider.provider_type }}
              </el-tag>
            </div>
            <div class="provider-actions">
              <el-checkbox
                v-model="provider.is_active"
                size="small"
                @change="updateActiveProviders">
                默认
              </el-checkbox>
              <el-button size="small" @click="testProvider(provider.name)">
                测试
              </el-button>
              <el-button size="small" type="danger" @click="deleteProvider(provider.name)">
                删除
              </el-button>
            </div>
          </div>
        </template>

        <div class="provider-details">
          <div class="detail-row">
            <span class="label">模型:</span>
            <span class="value">{{ provider.model }}</span>
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
        <el-form-item label="Provider 类型" prop="provider_type">
          <el-select v-model="formData.provider_type" placeholder="请选择 Provider 类型">
            <el-option label="OpenAI" value="openai" />
            <el-option label="DeepSeek" value="deepseek" />
            <el-option label="OpenRouter" value="openrouter" />
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
        </el-form-item>

        <el-form-item label="API 端点" prop="api_endpoint">
          <el-input v-model="formData.api_endpoint" :placeholder="getDefaultEndpoint()" />
        </el-form-item>

        <el-form-item label="模型" prop="model">
          <el-input v-model="formData.model" placeholder="输入模型名称" />
        </el-form-item>

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
          <el-form-item label="提示词">
            <el-input
              v-model="testPrompt"
              type="textarea"
              :rows="3"
              placeholder="输入测试提示词"
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
          </el-descriptions>

          <el-divider>响应内容</el-divider>
          <el-input
            v-model="testResult.content"
            type="textarea"
            :rows="6"
            readonly
          />
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Refresh, Connection } from '@element-plus/icons-vue'
import { get, post, put, del } from '@/api/http'

// 数据
const providers = ref([])
const loadBalancer = ref('round_robin')
const dialogVisible = ref(false)
const testDialogVisible = ref(false)
const dialogTitle = ref('添加 Provider')
const testPrompt = ref('你好，请介绍一下自己')
const testResult = ref(null)
const testLoading = ref(false)
const formRef = ref(null)
const currentProvider = ref(null)

// 表单数据
const formData = ref({
  provider_type: 'openai',
  name: '',
  api_key: '',
  api_endpoint: '',
  model: '',
  temperature: 0.7,
  max_tokens: 4096,
  timeout: 30,
  retry_attempts: 3,
  supports_function_calling: true
})

// 表单规则
const formRules = {
  provider_type: [{ required: true, message: '请选择 Provider 类型', trigger: 'change' }],
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  api_key: [{ required: true, message: '请输入 API Key', trigger: 'blur' }],
  model: [{ required: true, message: '请输入模型名称', trigger: 'blur' }]
}

// 默认端点
const defaultEndpoints = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1'
}

// 方法
const getDefaultEndpoint = () => {
  return defaultEndpoints[formData.value.provider_type] || ''
}

const loadProviders = async () => {
  try {
    const res = await get('/api/llm-adapter/providers')
    providers.value = res.providers || []
    loadBalancer.value = res.load_balancer || 'round_robin'
  } catch (error) {
    ElMessage.error('加载 Provider 列表失败')
  }
}

const getProviderTypeTag = (type) => {
  const tags = {
    openai: 'primary',
    deepseek: 'warning',
    openrouter: 'success'
  }
  return tags[type] || 'info'
}

const showAddProviderDialog = () => {
  dialogTitle.value = '添加 Provider'
  currentProvider.value = null
  formData.value = {
    provider_type: 'openai',
    name: '',
    api_key: '',
    api_endpoint: '',
    model: '',
    temperature: 0.7,
    max_tokens: 4096,
    timeout: 30,
    retry_attempts: 3,
    supports_function_calling: true
  }
  dialogVisible.value = true
}

const submitForm = async () => {
  if (!formRef.value) return

  await formRef.value.validate(async (valid) => {
    if (!valid) return

    try {
      if (currentProvider.value) {
        await put(`/api/llm-adapter/providers/${currentProvider.value}`, formData.value)
        ElMessage.success('更新成功')
      } else {
        await post('/api/llm-adapter/providers', formData.value)
        ElMessage.success('添加成功')
      }

      dialogVisible.value = false
      loadProviders()
    } catch (error) {
      ElMessage.error(currentProvider.value ? '更新失败' : '添加失败')
    }
  })
}

const deleteProvider = async (name) => {
  try {
    await ElMessageBox.confirm('确定要删除该 Provider 吗？', '确认删除', {
      type: 'warning'
    })

    await del(`/api/llm-adapter/providers/${name}`)
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
    await post(`/api/llm-adapter/active-provider`, { provider: name })
    ElMessage.success('设置成功')
    loadProviders()
  } catch (error) {
    ElMessage.error('设置失败')
  }
}

const updateActiveProviders = async () => {
  try {
    const activeProviderNames = providers.value
      .filter(p => p.is_active)
      .map(p => p.name)

    await post('/api/llm-adapter/active-providers', {
      providers: activeProviderNames
    })
    ElMessage.success('默认 Provider 设置成功')
  } catch (error) {
    ElMessage.error('设置失败')
  }
}

const testProvider = (name) => {
  currentProvider.value = name
  testResult.value = null
  testPrompt.value = '你好，请介绍一下自己'
  testDialogVisible.value = true
}

const testAllProviders = () => {
  currentProvider.value = null
  testResult.value = null
  testPrompt.value = '你好，请介绍一下自己'
  testDialogVisible.value = true
}

const runTest = async () => {
  if (!testPrompt.value.trim()) {
    ElMessage.warning('请输入测试提示词')
    return
  }

  testLoading.value = true
  testResult.value = null

  try {
    const res = await post('/api/llm-adapter/test', {
      provider: currentProvider.value,
      prompt: testPrompt.value
    })
    testResult.value = res.response
  } catch (error) {
    ElMessage.error('测试失败')
  } finally {
    testLoading.value = false
  }
}

const updateLoadBalancer = async () => {
  try {
    await post('/api/llm-adapter/load-balancer', { strategy: loadBalancer.value })
    ElMessage.success('设置成功')
  } catch (error) {
    ElMessage.error('设置失败')
  }
}

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
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid #f0f0f0;
}

.detail-row:last-child {
  border-bottom: none;
}

.detail-row .label {
  color: #606266;
  font-size: 14px;
}

.detail-row .value {
  color: #303133;
  font-size: 14px;
  font-weight: 500;
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
