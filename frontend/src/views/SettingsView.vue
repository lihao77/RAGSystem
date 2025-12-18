<template>
  <div class="settings-container">
    <!-- 页面头部 -->
    <div class="page-header">
      <h1>系统配置</h1>
      <p class="page-subtitle">管理系统配置参数，支持实时编辑和测试</p>
    </div>

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

      <!-- 地理编码状态卡片已移除 - 后续添加llmjson和json2graph时重新添加 -->

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

        <el-form-item>
          <el-button type="success" plain @click="testLLM" :loading="testing.llm">
            <el-icon>
              <ChatDotRound />
            </el-icon>
            测试 API 连接
          </el-button>
        </el-form-item>

        <!-- 地理编码配置已移除 - 后续添加llmjson和json2graph时重新添加 -->

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
  CircleClose
} from '@element-plus/icons-vue'
import {
  getConfig,
  getRawConfig,
  updateConfig,
  testNeo4jConnection,
  testLLMConnection,
  reloadConfig,
  validateConfig
} from '@/api/config'

defineOptions({ name: 'SettingsView' })

// 表单引用
const configForm = ref(null)

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
  }
})

// 加载状态
const loading = reactive({
  config: false,
  saving: false,
  reloading: false
})

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
  return {
    text: configStatus.llm.hasApiKey ? '密钥已设置' : '密钥未设置',
    type: configStatus.llm.hasApiKey ? 'success' : 'warning'
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
    { required: true, message: '请输入 LLM API 端点', trigger: 'blur' },
    { type: 'url', message: '请输入有效的 URL', trigger: 'blur' }
  ],
  'llm.model_name': [
    { required: true, message: '请输入模型名称', trigger: 'blur' }
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

  // LLM 状态
  configStatus.llm.valid = !!(config.llm.api_endpoint && config.llm.model_name)
  configStatus.llm.hasApiKey = !!config.llm.api_key
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

    // 准备保存的数据
    const configToSave = {
      neo4j: { ...config.neo4j },
      llm: { ...config.llm },
      system: { ...config.system },
      external_libs: {
        llmjson: {},
        json2graph: {}
      }
    }

    // 发送更新请求
    const res = await updateConfig(configToSave)
    if (res.success) {
      ElMessage.success('配置保存成功')

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

// 测试 LLM 连接
const testLLM = async () => {
  testing.llm = true
  try {
    const res = await testLLMConnection(config.llm)

    if (res.success) {
      ElMessage.success('LLM 连接成功')
      if (res.data?.reply) {
        ElMessage.info('测试回复: ' + res.data.reply)
      }
    } else {
      ElMessage.error(res.message)
    }
  } catch (error) {
    ElMessage.error('测试失败: ' + error.message)
  } finally {
    testing.llm = false
  }
}

// 初始化
onMounted(() => {
  loadConfig()
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
