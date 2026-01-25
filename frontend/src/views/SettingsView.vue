<template>
  <div class="settings-container">
    <!-- 页面头部 -->
    <div class="page-header">
      <h1>系统配置</h1>
      <p class="page-subtitle">管理系统配置参数，支持实时编辑和测试</p>
    </div>

    <!-- 服务状态监控面板 -->
    <el-card class="service-status-card" shadow="hover">
      <template #header>
        <div class="card-header">
          <h2>服务状态</h2>
          <el-button size="small" @click="refreshServiceStatus" :loading="loading.serviceStatus">
            <el-icon><Refresh /></el-icon>
            刷新状态
          </el-button>
        </div>
      </template>
      
      <div class="service-status-list">
        <div v-for="service in serviceStatus" :key="service.name" class="service-item">
          <div class="service-info">
            <div class="service-header">
              <el-icon class="service-icon" :class="getServiceIconClass(service.status)">
                <component :is="getServiceIcon(service.status)" />
              </el-icon>
              <span class="service-name">{{ service.name }}</span>
              <el-tag :type="getServiceTagType(service.status)" size="small">
                {{ getServiceStatusText(service.status) }}
              </el-tag>
            </div>
            <p class="service-message">{{ service.message }}</p>
          </div>
          
          <div class="service-actions">
            <el-button v-if="service.status === 'not_configured'"
                       size="small"
                       type="warning"
                       @click="scrollToConfig(service.name)">
              立即配置
            </el-button>
            <el-button v-else-if="service.status === 'error'"
                       size="small"
                       type="primary"
                       @click="reinitServiceHandler(service.name)">
              重新初始化
            </el-button>
            <el-button v-else-if="service.configured"
                       size="small"
                       @click="reinitServiceHandler(service.name)">
              重新加载
            </el-button>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 配置状态概览卡片 -->
    <el-row :gutter="20" class="status-cards">
      <el-col :span="6">
        <el-card class="status-card" shadow="hover">
          <div class="status-card-content">
            <el-icon class="status-icon" :class="{ 'status-success': configStatus.neo4j.valid }">
              <component :is="neo4jStatusIcon" />
            </el-icon>
            <div class="status-info">
              <h3>Neo4j</h3>
              <p>{{ configStatus.neo4j.valid ? '已配置' : '未配置' }}</p>
              <el-tag :type="neo4jPasswordTag.type" size="small">{{ neo4jPasswordTag.text }}</el-tag>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="6">
        <el-card class="status-card" shadow="hover">
          <div class="status-card-content">
            <el-icon class="status-icon" :class="{ 'status-success': configStatus.llm.valid }">
              <component :is="llmStatusIcon" />
            </el-icon>
            <div class="status-info">
              <h3>LLM API</h3>
              <p>{{ configStatus.llm.valid ? '已配置' : '未配置' }}</p>
              <el-tag :type="llmKeyTag.type" size="small">{{ llmKeyTag.text }}</el-tag>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="6">
        <el-card class="status-card" shadow="hover">
          <div class="status-card-content">
            <el-icon class="status-icon" :class="{ 'status-success': configStatus.embedding.valid }">
              <component :is="embeddingStatusIcon" />
            </el-icon>
            <div class="status-info">
              <h3>嵌入模型</h3>
              <p>{{ config.embedding.mode === 'local' ? '本地模型' : 'API 模式' }}</p>
              <el-tag :type="embeddingTag.type" size="small">{{ embeddingTag.text }}</el-tag>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="6">
        <el-card class="status-card" shadow="hover">
          <div class="status-card-content">
            <el-icon class="status-icon">
              <Tools />
            </el-icon>
            <div class="status-info">
              <h3>系统</h3>
              <p>系统配置</p>
              <el-tag size="small" type="info">运行中</el-tag>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 配置编辑区域 -->
    <el-card class="config-editor-card" shadow="never">
      <template #header>
        <div class="card-header">
          <h2>配置编辑</h2>
          <div class="header-actions">
            <el-button type="primary" :loading="loading.saving" @click="saveConfig">
              <span class="icon-wrapper">
                <el-icon v-show="!loading.saving">
                  <Check />
                </el-icon>
                保存配置
              </span>
            </el-button>
            <el-button @click="reloadConfigHandler" :loading="loading.reloading">
              <span class="icon-wrapper">
                <el-icon v-show="!loading.reloading">
                  <Refresh />
                </el-icon>
                重新加载
              </span>
            </el-button>
          </div>
        </div>
      </template>

      <!-- 配置表单 -->
      <el-form ref="configForm" :model="config" :rules="configRules" label-width="140px" label-position="right"
        class="config-form">
        <!-- Neo4j 配置 -->
        <el-divider content-position="left">
          <el-icon>
            <HomeFilled />
          </el-icon>
          Neo4j 数据库配置
        </el-divider>

        <el-row :gutter="20">
          <el-col :span="12">
            <el-form-item label="连接地址" prop="neo4j.uri">
              <el-input v-model="config.neo4j.uri" placeholder="bolt://localhost:7687">
                <template #prefix>
                  <el-icon>
                    <Link />
                  </el-icon>
                </template>
              </el-input>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="用户名" prop="neo4j.user">
              <el-input v-model="config.neo4j.user" placeholder="neo4j">
                <template #prefix>
                  <el-icon>
                    <User />
                  </el-icon>
                </template>
              </el-input>
            </el-form-item>
          </el-col>
        </el-row>

        <el-form-item label="密码" prop="neo4j.password">
          <el-input v-model="config.neo4j.password" type="password" placeholder="请输入 Neo4j 密码" show-password>
            <template #prefix>
              <el-icon>
                <Lock />
              </el-icon>
            </template>
          </el-input>
        </el-form-item>

        <el-form-item>
          <el-button type="success" plain @click="testNeo4j" :loading="testing.neo4j">
            <el-icon>
              <Connection />
            </el-icon>
            测试连接
          </el-button>
        </el-form-item>

        <!-- LLM 配置 -->
        <el-divider content-position="left">
          <el-icon>
            <ChatDotRound />
          </el-icon>
          LLM API 配置
        </el-divider>

        <el-alert
          title="推荐使用 LLMAdapter 统一管理 LLM 配置，支持多提供商和负载均衡"
          type="info"
          :closable="false"
          show-icon
          style="margin-bottom: 20px"
        />

        <LLMConfigSelector v-model="llmConfig" />

        <el-collapse v-model="advancedLlmConfig">
          <el-collapse-item title="高级配置（旧版配置方式）" name="advanced">
            <el-row :gutter="20">
              <el-col :span="12">
                <el-form-item label="API 端点" prop="llm.api_endpoint">
                  <el-input v-model="config.llm.api_endpoint" placeholder="https://api.deepseek.com/v1">
                    <template #prefix>
                      <el-icon>
                        <Position />
                      </el-icon>
                    </template>
                  </el-input>
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="模型名称" prop="llm.model_name">
                  <el-input v-model="config.llm.model_name" placeholder="deepseek-chat">
                    <template #prefix>
                      <el-icon>
                        <Cpu />
                      </el-icon>
                    </template>
                  </el-input>
                </el-form-item>
              </el-col>
            </el-row>

            <el-form-item label="API 密钥" prop="llm.api_key">
              <el-input v-model="config.llm.api_key" type="password" placeholder="请输入 LLM API 密钥" show-password>
                <template #prefix>
                  <el-icon>
                    <Key />
                  </el-icon>
                </template>
              </el-input>
            </el-form-item>

            <el-row :gutter="20">
              <el-col :span="12">
                <el-form-item label="生成温度" prop="llm.temperature">
                  <el-slider v-model="config.llm.temperature" :min="0" :max="2" :step="0.1" show-input />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="最大令牌数" prop="llm.max_tokens">
                  <el-input-number v-model="config.llm.max_tokens" :min="100" :max="32000" :step="512"
                    style="width: 100%" />
                </el-form-item>
              </el-col>
            </el-row>
          </el-collapse-item>
        </el-collapse>

        <!-- 地理编码配置已移除 - 后续添加llmjson和json2graph时重新添加 -->

        <!-- 嵌入模型配置 -->
        <el-divider content-position="left">
          <el-icon>
            <DataAnalysis />
          </el-icon>
          嵌入模型配置
        </el-divider>

        <el-form-item label="嵌入模式">
          <el-radio-group v-model="config.embedding.mode">
            <el-radio label="local">本地模型</el-radio>
            <el-radio label="remote">远程 API</el-radio>
          </el-radio-group>
        </el-form-item>

        <!-- 本地模型配置 -->
        <template v-if="config.embedding.mode === 'local'">
          <el-row :gutter="20">
            <el-col :span="16">
              <el-form-item label="模型名称" prop="embedding.local.model_name">
                <el-select v-model="config.embedding.local.model_name" placeholder="选择本地模型" style="width: 100%">
                  <el-option label="BAAI/bge-large-zh-v1.5 (推荐)" value="BAAI/bge-large-zh-v1.5" />
                  <el-option label="BAAI/bge-small-zh-v1.5 (轻量)" value="BAAI/bge-small-zh-v1.5" />
                  <el-option label="paraphrase-multilingual-MiniLM-L12-v2 (多语言)" value="paraphrase-multilingual-MiniLM-L12-v2" />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="设备" prop="embedding.local.device">
                <el-select v-model="config.embedding.local.device" placeholder="选择设备" style="width: 100%">
                  <el-option label="CPU" value="cpu" />
                  <el-option label="CUDA (GPU)" value="cuda" />
                </el-select>
              </el-form-item>
            </el-col>
          </el-row>
        </template>

        <!-- API 模型配置 -->
        <template v-if="config.embedding.mode === 'remote'">
          <el-row :gutter="20">
            <el-col :span="12">
              <el-form-item label="API 端点" prop="embedding.remote.api_endpoint">
                <el-input v-model="config.embedding.remote.api_endpoint" placeholder="https://api.openai.com/v1">
                  <template #prefix>
                    <el-icon>
                      <Link />
                    </el-icon>
                  </template>
                </el-input>
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="模型名称" prop="embedding.remote.model_name">
                <el-input v-model="config.embedding.remote.model_name" placeholder="text-embedding-3-small">
                  <template #prefix>
                    <el-icon>
                      <Cpu />
                    </el-icon>
                  </template>
                </el-input>
              </el-form-item>
            </el-col>
          </el-row>

          <el-form-item label="API 密钥" prop="embedding.remote.api_key">
            <el-input v-model="config.embedding.remote.api_key" type="password" placeholder="请输入 Embedding API 密钥" show-password>
              <template #prefix>
                <el-icon>
                  <Key />
                </el-icon>
              </template>
            </el-input>
          </el-form-item>

          <el-row :gutter="20">
            <el-col :span="12">
              <el-form-item label="超时时间(秒)" prop="embedding.remote.timeout">
                <el-input-number v-model="config.embedding.remote.timeout" :min="5" :max="120" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="最大重试次数" prop="embedding.remote.max_retries">
                <el-input-number v-model="config.embedding.remote.max_retries" :min="0" :max="10" />
              </el-form-item>
            </el-col>
          </el-row>
        </template>

        <!-- 系统配置 -->
        <el-divider content-position="left">
          <el-icon>
            <Setting />
          </el-icon>
          系统设置
        </el-divider>

        <!-- 系统设置：max_content_length 配置已移除，后续需要时添加 -->
      </el-form>
    </el-card>

    <!-- 提示信息 -->
    <el-alert title="提示：配置修改后，敏感信息（如密码、API密钥）在显示时会被隐藏。点击'保存配置'后，配置将立即生效。" type="info" :closable="false" show-icon
      style="margin-top: 20px" />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, computed } from 'vue'
import { ElMessage } from 'element-plus'
import {
  HomeFilled, Link, User, Lock, Position, Cpu, Key, Connection, Check,
  Refresh, Tools, Setting, ChatDotRound, CircleCheck,
  CircleClose, DataAnalysis
} from '@element-plus/icons-vue'
import {
  getConfig,
  getRawConfig,
  updateConfig,
  testNeo4jConnection,
  testLLMConnection,
  reloadConfig,
  validateConfig,
  getServicesStatus,
  reinitService
} from '@/api/config'
import { resetConfigStatusCache } from '@/composables/useConfigCheck'
import LLMConfigSelector from '@/components/LLMConfigSelector.vue'

defineOptions({ name: 'SettingsView' })

// 表单引用
const configForm = ref(null)

// LLM 配置（用于 LLMConfigSelector 组件）
const llmConfig = ref({
  provider: '',
  model_name: '',
  temperature: 0.7,
  max_tokens: 4096,
  timeout: 30,
  retry_attempts: 3
})

// 高级 LLM 配置折叠面板
const advancedLlmConfig = ref([])

// 配置数据
const config = reactive({
  neo4j: {
    uri: 'bolt://localhost:7687',
    user: 'neo4j',
    password: ''
  },
  llm: {
    api_endpoint: 'https://api.deepseek.com/v1',
    api_key: '',
    model_name: 'deepseek-chat',
    temperature: 0.7,
    max_tokens: 4096
  },
  embedding: {
    mode: 'local',
    local: {
      model_name: 'BAAI/bge-small-zh-v1.5',
      device: 'cpu',
      cache_dir: null
    },
    remote: {
      api_endpoint: '',
      api_key: '',
      model_name: 'text-embedding-3-small',
      timeout: 30,
      max_retries: 3
    }
  },
  system: {}
})

// 配置状态
const configStatus = reactive({
  neo4j: {
    valid: false,
    hasPassword: false
  },
  llm: {
    valid: false,
    hasApiKey: false
  },
  embedding: {
    valid: false
  }
})

// 加载状态
const loading = reactive({
  config: false,
  saving: false,
  reloading: false,
  serviceStatus: false
})

// 服务状态
const serviceStatus = ref([
  {
    name: 'Neo4j',
    configured: false,
    status: 'not_configured',
    message: '未配置'
  },
  {
    name: '向量数据库',
    configured: false,
    status: 'not_configured',
    message: '未配置嵌入模型'
  },
  {
    name: 'LLM',
    configured: false,
    status: 'not_configured',
    message: '未配置'
  }
])

// 测试状态
const testing = reactive({
  neo4j: false,
  llm: false
})

// 计算属性：Neo4j 状态图标
const neo4jStatusIcon = computed(() => {
  return configStatus.neo4j.valid ? CircleCheck : CircleClose
})

// 计算属性：Neo4j 密码标签
const neo4jPasswordTag = computed(() => {
  return {
    text: configStatus.neo4j.hasPassword ? '密码已设置' : '密码未设置',
    type: configStatus.neo4j.hasPassword ? 'success' : 'warning'
  }
})

// 计算属性：LLM 状态图标
const llmStatusIcon = computed(() => {
  return configStatus.llm.valid ? CircleCheck : CircleClose
})

// 计算属性：LLM 密钥标签
const llmKeyTag = computed(() => {
  if (llmConfig.value.provider) {
    return {
      text: '使用 LLMAdapter',
      type: 'success'
    }
  }
  return {
    text: configStatus.llm.hasApiKey ? '密钥已设置' : '密钥未设置',
    type: configStatus.llm.hasApiKey ? 'success' : 'warning'
  }
})

// 计算属性：嵌入模型状态图标
const embeddingStatusIcon = computed(() => {
  return configStatus.embedding.valid ? CircleCheck : CircleClose
})

// 计算属性：嵌入模型标签
const embeddingTag = computed(() => {
  if (config.embedding.mode === 'local') {
    return {
      text: config.embedding.local?.model_name ? '已配置' : '未配置',
      type: config.embedding.local?.model_name ? 'success' : 'warning'
    }
  } else {
    return {
      text: config.embedding.remote?.api_key ? '密钥已设置' : '密钥未设置',
      type: config.embedding.remote?.api_key ? 'success' : 'warning'
    }
  }
})

// 表单验证规则
const configRules = {
  'neo4j.uri': [
    { required: true, message: '请输入 Neo4j 连接地址', trigger: 'blur' }
  ],
  'neo4j.user': [
    { required: true, message: '请输入 Neo4j 用户名', trigger: 'blur' }
  ],
  'llm.api_endpoint': [
    { type: 'url', message: '请输入有效的 URL', trigger: 'blur' }
  ]
}

// 加载配置
const loadConfig = async (showMessage = true) => {
  loading.config = true
  try {
    const res = await getRawConfig()
    if (res.success) {
      // 合并配置（保留reactive的响应性）
      Object.assign(config.neo4j, res.data.neo4j || {})
      Object.assign(config.llm, res.data.llm || {})
      Object.assign(config.system, res.data.system || {})

      // 处理 embedding 配置 - 确保嵌套结构
      if (res.data.embedding) {
        config.embedding.mode = res.data.embedding.mode || 'local'

        // 确保 local 和 remote 对象存在
        if (!config.embedding.local) {
          config.embedding.local = {}
        }
        if (!config.embedding.remote) {
          config.embedding.remote = {}
        }

        // 合并 local 配置
        if (res.data.embedding.local) {
          Object.assign(config.embedding.local, res.data.embedding.local)
        }

        // 合并 remote 配置
        if (res.data.embedding.remote) {
          Object.assign(config.embedding.remote, res.data.embedding.remote)
        }
      }

      // 同步 LLM 配置到 llmConfig（用于 LLMConfigSelector 组件）
      Object.assign(llmConfig.value, {
        provider: config.llm.provider || '',
        model_name: config.llm.model_name || config.llm.model || '',
        temperature: config.llm.temperature,
        max_tokens: config.llm.max_tokens,
        timeout: config.llm.timeout || 30,
        retry_attempts: config.llm.retry_attempts || 3
      })

      // 更新状态
      updateStatus()
      if (showMessage) {
        ElMessage.success('配置加载成功')
      }
    } else {
      if (showMessage) {
        ElMessage.error('配置加载失败: ' + res.message)
      }
    }
  } catch (error) {
    if (showMessage) {
      ElMessage.error('配置加载失败: ' + error.message)
    }
  } finally {
    loading.config = false
  }
}

// 更新配置状态
const updateStatus = () => {
  // Neo4j 状态
  configStatus.neo4j.valid = !!(config.neo4j.uri && config.neo4j.user)
  configStatus.neo4j.hasPassword = !!config.neo4j.password

  // LLM 状态 - 使用 LLMAdapter 或旧的配置方式
  if (llmConfig.value.provider) {
    configStatus.llm.valid = true
    configStatus.llm.hasApiKey = true
  } else {
    // 旧的验证方式
    configStatus.llm.valid = !!(config.llm.api_endpoint && config.llm.model_name)
    configStatus.llm.hasApiKey = !!config.llm.api_key
  }

  // 嵌入模型状态
  if (config.embedding.mode === 'local') {
    configStatus.embedding.valid = !!config.embedding.local_model
  } else {
    configStatus.embedding.valid = !!(config.embedding.api_base && config.embedding.api_model && config.embedding.api_key)
  }
}

// 保存配置
const saveConfig = async () => {
  try {
    // 验证表单
    await configForm.value.validate()

    // 验证配置格式
    const validateRes = await validateConfig(config)
    if (!validateRes.success) {
      ElMessage.error('配置验证失败: ' + validateRes.message)
      return
    }

    loading.saving = true

    // 同步 LLM 配置从 llmConfig 到 config.llm
    config.llm.provider = llmConfig.value.provider
    config.llm.model_name = llmConfig.value.model_name
    config.llm.temperature = llmConfig.value.temperature
    config.llm.max_tokens = llmConfig.value.max_tokens
    config.llm.timeout = llmConfig.value.timeout
    config.llm.retry_attempts = llmConfig.value.retry_attempts

    // 准备保存的数据
    const configToSave = {
      neo4j: { ...config.neo4j },
      llm: { ...config.llm },
      system: { ...config.system },
      embedding: { ...config.embedding },
      external_libs: {
        llmjson: {},
        json2graph: {}
      }
    }

    // 发送更新请求
    const res = await updateConfig(configToSave)
    if (res.success) {
      ElMessage.success('配置保存成功')

      // 清除配置状态缓存（重要！）
      resetConfigStatusCache()
      console.log('配置缓存已清除，下次路由检查将使用新配置')

      // 热重载配置
      await reloadConfigHandler()
    } else {
      ElMessage.error('配置保存失败: ' + res.message)
    }
  } catch (error) {
    if (error.message) {
      ElMessage.error('配置验证失败: ' + error.message)
    }
  } finally {
    loading.saving = false
  }
}

// 重新加载配置
const reloadConfigHandler = async () => {
  loading.reloading = true
  try {
    const res = await reloadConfig()
    if (res.success) {
      // 重新加载配置（不显示加载消息，只显示热重载成功消息）
      await loadConfig(false)
      ElMessage.success('配置热重载成功')
    } else {
      ElMessage.error('配置热重载失败: ' + res.message)
    }
  } catch (error) {
    ElMessage.error('配置热重载失败: ' + error.message)
  } finally {
    loading.reloading = false
  }
}

// 测试 Neo4j 连接
const testNeo4j = async () => {
  testing.neo4j = true
  try {
    const res = await testNeo4jConnection(config.neo4j)
    console.log(res.success)
    if (res.success) {
      ElMessage.success(res.message)
    } else {
      ElMessage.error(res.message)
    }
  } catch (error) {
    ElMessage.error('测试失败: ' + error.message)
  } finally {
    testing.neo4j = false
  }
}

// 测试 LLM 连接 - 已由 LLMConfigSelector 组件处理
const testLLM = async () => {
  // 此函数已废弃，测试功能在 LLMConfigSelector 组件中处理
}

// 刷新服务状态
const refreshServiceStatus = async () => {
  loading.serviceStatus = true
  try {
    const res = await getServicesStatus()

    if (res.success && res.data.services) {
      serviceStatus.value = res.data.services.map(service => ({
        name: service.name,
        configured: service.configured,
        status: service.status,
        message: service.message
      }))
    }
  } catch (error) {
    ElMessage.error('获取服务状态失败: ' + error.message)
  } finally {
    loading.serviceStatus = false
  }
}

// 重新初始化服务
const reinitServiceHandler = async (serviceName) => {
  const serviceMap = {
    'Neo4j': 'neo4j',
    '向量数据库': 'vector',
    'LLM': 'llm'
  }

  const serviceKey = serviceMap[serviceName]
  if (!serviceKey) return

  try {
    const res = await reinitService(serviceKey)

    if (res.success) {
      ElMessage.success(res.message)
      refreshServiceStatus()
    } else {
      ElMessage.error(res.message)
    }
  } catch (error) {
    ElMessage.error('重新初始化失败: ' + error.message)
  }
}

// 滚动到配置区域
const scrollToConfig = (serviceName) => {
  // 简单实现：提示用户
  ElMessage.info(`请在下方配置 ${serviceName}`)
}

// 获取服务状态图标
const getServiceIcon = (status) => {
  const iconMap = {
    'ready': CircleCheck,
    'error': CircleClose,
    'not_configured': Setting,
    'initializing': Refresh
  }
  return iconMap[status] || Setting
}

// 获取服务图标类名
const getServiceIconClass = (status) => {
  return {
    'icon-ready': status === 'ready',
    'icon-error': status === 'error',
    'icon-warning': status === 'not_configured',
    'icon-loading': status === 'initializing'
  }
}

// 获取服务标签类型
const getServiceTagType = (status) => {
  const typeMap = {
    'ready': 'success',
    'error': 'danger',
    'not_configured': 'warning',
    'initializing': 'info'
  }
  return typeMap[status] || 'info'
}

// 获取服务状态文本
const getServiceStatusText = (status) => {
  const textMap = {
    'ready': '已就绪',
    'error': '错误',
    'not_configured': '未配置',
    'initializing': '初始化中'
  }
  return textMap[status] || '未知'
}

// 初始化
onMounted(() => {
  loadConfig()
  refreshServiceStatus()
})
</script>

<style scoped>
.settings-container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 20px;
}

.page-header {
  margin-bottom: 30px;
  padding-bottom: 20px;
  border-bottom: 1px solid #ebeef5;
}

.page-header h1 {
  margin: 0 0 8px 0;
  font-size: 28px;
  font-weight: 500;
  color: #303133;
}

.page-subtitle {
  margin: 0;
  font-size: 14px;
  color: #909399;
}

/* 服务状态面板 */
.service-status-card {
  margin-bottom: 20px;
  border-radius: 8px;
}

.service-status-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.service-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background-color: #f5f7fa;
  border-radius: 6px;
  transition: all 0.3s ease;
}

.service-item:hover {
  background-color: #ecf0f5;
}

.service-info {
  flex: 1;
}

.service-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.service-icon {
  font-size: 20px;
}

.icon-ready {
  color: #67c23a;
}

.icon-error {
  color: #f56c6c;
}

.icon-warning {
  color: #e6a23c;
}

.icon-loading {
  color: #409eff;
  animation: rotate 2s linear infinite;
}

@keyframes rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.service-name {
  font-size: 16px;
  font-weight: 500;
  color: #303133;
}

.service-message {
  margin: 0;
  padding-left: 30px;
  font-size: 13px;
  color: #606266;
}

.service-actions {
  display: flex;
  gap: 8px;
}

/* 状态卡片 */
.status-cards {
  margin-bottom: 30px;
}

.status-card {
  border-radius: 8px;
  transition: all 0.3s ease;
}

.status-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.status-card-content {
  display: flex;
  align-items: center;
  padding: 20px 10px;
}

.status-icon {
  font-size: 32px;
  margin-right: 15px;
  color: #dcdfe6;
}

.status-icon.status-success {
  color: #67c23a;
}

.status-icon.status-error {
  color: #f56c6c;
}

.status-info h3 {
  margin: 0 0 5px 0;
  font-size: 16px;
  font-weight: 500;
  color: #303133;
}

.status-info p {
  margin: 0 0 8px 0;
  font-size: 14px;
  color: #909399;
}

/* 配置编辑器 */
.config-editor-card {
  border-radius: 8px;
  overflow: hidden;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-header h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 500;
  color: #303133;
}

.icon-wrapper {
  display: inline-flex;
  align-items: right;
  gap: 8px; /* 控制间距 */
}

.header-actions {
  display: flex;
  gap: 12px;
}

.header-actions .el-button {
  min-width: 110px;
  justify-content: center;
}

.config-form {
  max-width: 100%;
}

/* 分节标题 */
:deep(.el-divider__text) {
  font-size: 16px;
  font-weight: 500;
  color: #303133;
}

:deep(.el-divider__text .el-icon) {
  margin-right: 8px;
  vertical-align: middle;
}

/* 响应式布局 */
@media (max-width: 768px) {
  .settings-container {
    padding: 10px;
  }

  .page-header h1 {
    font-size: 24px;
  }

  .status-card-content {
    padding: 15px 10px;
  }

  .status-icon {
    font-size: 24px;
    margin-right: 10px;
  }

  .header-actions {
    flex-direction: column;
    gap: 8px;
  }

  .config-form {
    :deep(.el-form-item__label) {
      text-align: left;
      padding-bottom: 8px;
    }
  }
}
</style>
