<template>
  <div class="llm-config-selector">
    <el-form-item label="LLM 配置">
      <el-select
        v-model="selectedProvider"
        placeholder="请选择 LLM 配置"
        clearable
        @change="handleProviderChange"
        style="width: 100%"
      >
        <el-option
          v-for="provider in providers"
          :key="provider.name"
          :label="provider.name"
          :value="provider.name"
        >
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span>{{ provider.name }}</span>
            <el-tag :type="getProviderTypeTag(provider.provider_type)" size="small">
              {{ provider.provider_type }}
            </el-tag>
          </div>
        </el-option>
      </el-select>
    </el-form-item>

    <template v-if="selectedProvider">
      <el-form-item label="模型">
        <template v-if="currentProvider.models && currentProvider.models.length > 0">
          <el-select
            v-model="model.model_name"
            placeholder="选择或输入模型名称"
            style="width: 100%"
            filterable
            allow-create
            default-first-option
          >
            <el-option
              v-for="modelName in currentProvider.models"
              :key="modelName"
              :label="modelName"
              :value="modelName"
            >
              {{ modelName }}
            </el-option>
          </el-select>
          <div style="font-size: 12px; color: #999; margin-top: 5px;">
            可以从列表选择，也可以输入不在列表中的模型名称
          </div>
        </template>
        <template v-else>
          <el-input
            v-model="model.model_name"
            placeholder="输入模型名称"
            clearable
          />
          <div style="font-size: 12px; color: #999; margin-top: 5px;">
            自由输入模型名称（该 Provider 未配置模型列表）
          </div>
        </template>
      </el-form-item>

      <el-row :gutter="20">
        <el-col :span="12">
          <el-form-item label="温度">
            <el-slider
              v-model="model.temperature"
              :min="0"
              :max="2"
              :step="0.1"
              show-input
              :show-tooltip="false"
            />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="最大Token">
            <el-input-number
              v-model="model.max_tokens"
              :min="100"
              :max="32000"
              :step="512"
              style="width: 100%"
            />
          </el-form-item>
        </el-col>
      </el-row>

      <el-row :gutter="20">
        <el-col :span="12">
          <el-form-item label="超时时间(秒)">
            <el-input-number
              v-model="model.timeout"
              :min="1"
              :max="300"
              :step="5"
              style="width: 100%"
            />
          </el-form-item>
        </el-col>
        <el-col :span="12">
          <el-form-item label="重试次数">
            <el-input-number
              v-model="model.retry_attempts"
              :min="0"
              :max="10"
              style="width: 100%"
            />
          </el-form-item>
        </el-col>
      </el-row>

      <el-form-item>
        <el-button
          type="primary"
          @click="testConnection"
          :loading="testLoading"
          size="small"
        >
          测试连接
        </el-button>
        <el-button
          type="success"
          plain
          @click="useAdvancedConfig"
          size="small"
        >
          高级配置
        </el-button>
      </el-form-item>
    </template>

    <el-alert
      v-else
      title="未选择 LLM 提供商，请在 LLMAdapter 中配置"
      type="warning"
      :closable="false"
      show-icon
    />

    <!-- 测试结果对话框 -->
    <el-dialog
      v-model="testDialogVisible"
      title="连接测试"
      width="600px"
    >
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
        </el-descriptions>

        <el-divider>响应内容</el-divider>
        <el-input
          v-model="testResult.content"
          type="textarea"
          :rows="6"
          readonly
        />
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { llmAdapterService } from '@/api'

const props = defineProps({
  modelValue: {
    type: Object,
    default: () => ({
      provider: '',
      model_name: '',
      temperature: 0.7,
      max_tokens: 4096,
      timeout: 30,
      retry_attempts: 3
    })
  }
})

const emit = defineEmits(['update:modelValue'])

// 数据
const providers = ref([])
const selectedProvider = ref('')
const testLoading = ref(false)
const testDialogVisible = ref(false)
const testPrompt = ref('你好，请介绍一下自己')
const testResult = ref(null)

// 计算属性
const currentProvider = computed(() => {
  return providers.value.find(p => p.name === selectedProvider.value) || {}
})

const model = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

// 方法
const loadProviders = async () => {
  try {
    const res = await llmAdapterService.getProviders()
    providers.value = res.providers || []

    // 如果有默认值，设置选中项
    if (props.modelValue.provider && providers.value.find(p => p.name === props.modelValue.provider)) {
      selectedProvider.value = props.modelValue.provider
    } else if (providers.value.length > 0) {
      // 尝试选择第一个激活的 provider
      const activeProviders = providers.value.filter(p => p.is_active)
      if (activeProviders.length > 0) {
        selectedProvider.value = activeProviders[0].name
        handleProviderChange(activeProviders[0].name)
      }
    }
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

const handleProviderChange = (providerName) => {
  const provider = providers.value.find(p => p.name === providerName)
  if (provider) {
    // 如果有预定义的模型列表，使用第一个作为默认值
    const defaultModel = provider.models && provider.models.length > 0 ? provider.models[0] : ''

    model.value = {
      ...model.value,
      provider: providerName,
      model_name: defaultModel,
      temperature: provider.temperature || 0.7,
      max_tokens: provider.max_tokens || 4096,
      timeout: provider.timeout || 30,
      retry_attempts: provider.retry_attempts || 3
    }
  }
}

const testConnection = () => {
  testDialogVisible.value = true
  testResult.value = null
  testPrompt.value = '你好，请介绍一下自己'
}

const runTest = async () => {
  if (!testPrompt.value.trim()) {
    ElMessage.warning('请输入测试提示词')
    return
  }

  if (!model.value.model_name) {
    ElMessage.warning('请选择或输入模型名称')
    return
  }

  testLoading.value = true
  testResult.value = null

  try {
    const res = await llmAdapterService.testProvider({
      provider: selectedProvider.value,
      model: model.value.model_name,
      prompt: testPrompt.value
    })
    testResult.value = res.response
  } catch (error) {
    ElMessage.error('测试失败')
  } finally {
    testLoading.value = false
  }
}

const useAdvancedConfig = () => {
  window.open('/llm-adapter', '_blank')
}

// 监听 modelValue 变化，同步 selectedProvider
watch(() => props.modelValue.provider, (newProvider) => {
  if (newProvider && providers.value.find(p => p.name === newProvider)) {
    selectedProvider.value = newProvider
  }
})

// 生命周期
onMounted(() => {
  loadProviders()
})
</script>

<style scoped>
.llm-config-selector {
  padding: 10px 0;
}

.test-result {
  margin-top: 20px;
}

:deep(.el-descriptions-item__label) {
  width: 100px;
}

/* :deep(.el-slider__input) {
  width: 80px;
} */
</style>
