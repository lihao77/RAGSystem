<template>
  <div class="agent-config-container">
    <div class="page-header">
      <h1>智能体配置管理</h1>
      <p class="page-subtitle">为每个智能体配置独立的 LLM 参数、工具设置和自定义参数</p>
    </div>

    <el-row :gutter="16">
      <!-- 左侧：智能体列表 -->
      <el-col :span="8" class="left-sidebar">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>智能体列表</span>
              <el-button size="small" @click="loadConfigs" :loading="loading">
                <el-icon><Refresh /></el-icon>
                刷新
              </el-button>
            </div>
          </template>

          <el-menu :default-active="selectedAgent" @select="onSelectAgent">
            <el-menu-item
              v-for="(config, name) in agentConfigs"
              :key="name"
              :index="name"
            >
              <div class="agent-item">
                <div class="agent-info">
                  <span class="agent-name">{{ config.display_name || name }}</span>
                  <el-tag
                    :type="config.enabled ? 'success' : 'info'"
                    size="small"
                    style="margin-left: 8px"
                  >
                    {{ config.enabled ? '启用' : '禁用' }}
                  </el-tag>
                </div>
                <div class="agent-desc">{{ config.description || '暂无描述' }}</div>
              </div>
            </el-menu-item>
          </el-menu>

          <el-empty v-if="Object.keys(agentConfigs).length === 0" description="暂无智能体配置" />
        </el-card>

        <!-- 预设模板 -->
        <el-card shadow="never" style="margin-top: 16px" v-if="selectedAgent">
          <template #header>
            <div class="card-header">
              <span>快速预设</span>
            </div>
          </template>

          <div class="presets-grid">
            <el-button
              v-for="(preset, key) in presets"
              :key="key"
              size="small"
              @click="applyPresetConfig(key)"
              :loading="applyingPreset === key"
            >
              {{ getPresetLabel(key) }}
            </el-button>
          </div>

          <el-alert
            title="预设说明"
            type="info"
            :closable="false"
            style="margin-top: 12px; font-size: 12px"
          >
            <ul style="margin: 0; padding-left: 20px">
              <li><strong>Fast</strong>: 快速响应，低温度</li>
              <li><strong>Balanced</strong>: 平衡模式（推荐）</li>
              <li><strong>Accurate</strong>: 精确模式，大模型</li>
              <li><strong>Creative</strong>: 创意模式，高温度</li>
              <li><strong>Cheap</strong>: 经济模式，便宜模型</li>
            </ul>
          </el-alert>
        </el-card>
      </el-col>

      <!-- 右侧：配置编辑 -->
      <el-col :span="16">
        <el-card shadow="never" v-if="selectedAgent && currentConfig">
          <template #header>
            <div class="card-header">
              <span>{{ currentConfig.display_name || selectedAgent }} - 配置</span>
              <div style="display: flex; gap: 8px">
                <el-button size="small" @click="loadConfigs">
                  <el-icon><Refresh /></el-icon>
                  重置
                </el-button>
                <el-button size="small" type="primary" @click="saveConfig" :loading="saving">
                  <el-icon><Check /></el-icon>
                  保存
                </el-button>
              </div>
            </div>
          </template>

          <el-form :model="currentConfig" label-width="140px" size="default">
            <!-- 基本信息 -->
            <el-divider content-position="left">基本信息</el-divider>

            <el-form-item label="智能体名称">
              <el-input :value="currentConfig.agent_name" disabled />
              <el-text size="small" type="info">名称不可修改</el-text>
            </el-form-item>

            <el-form-item label="显示名称">
              <el-input v-model="currentConfig.display_name" placeholder="友好的显示名称" disabled />
              <el-text size="small" type="info">基本信息不可修改</el-text>
            </el-form-item>

            <el-form-item label="描述">
              <el-input
                v-model="currentConfig.description"
                type="textarea"
                :rows="2"
                placeholder="智能体的功能描述"
                disabled
              />
              <el-text size="small" type="info">基本信息不可修改</el-text>
            </el-form-item>

            <el-form-item label="启用状态">
              <el-switch
                v-model="currentConfig.enabled"
                active-text="启用"
                inactive-text="禁用"
              />
            </el-form-item>

            <!-- LLM 配置 -->
            <el-divider content-position="left">LLM 配置</el-divider>

            <el-alert
              title="LLM 配置说明"
              type="info"
              :closable="false"
              style="margin-bottom: 16px"
            >
              从 LLM Adapter 中选择配置的 Provider 和模型。如果未选择，将使用系统默认配置。
            </el-alert>

            <LLMConfigSelector v-model="currentConfig.llm" />

            <!-- 工具配置 -->
            <el-divider content-position="left">工具配置</el-divider>

            <el-form-item label="启用的工具">
              <el-select
                v-model="currentConfig.tools.enabled_tools"
                multiple
                placeholder="选择启用的工具（留空表示全部启用）"
                style="width: 100%"
                clearable
                filterable
              >
                <el-option-group
                  v-for="category in toolCategories"
                  :key="category.name"
                  :label="category.label"
                >
                  <el-option
                    v-for="tool in category.tools"
                    :key="tool.name"
                    :label="tool.display_name"
                    :value="tool.name"
                  />
                </el-option-group>
              </el-select>
              <el-alert
                type="info"
                :closable="false"
                style="margin-top: 8px"
              >
                <template #default>
                  <div style="font-size: 12px">
                    <strong>工具启用逻辑：</strong>
                    <ul style="margin: 4px 0 0 0; padding-left: 20px">
                      <li>不选择任何工具 = 启用所有工具（默认）</li>
                      <li>选择特定工具 = 仅启用选中的工具</li>
                      <li>若要完全禁用该智能体，请关闭上方的"启用状态"开关</li>
                    </ul>
                  </div>
                </template>
              </el-alert>
            </el-form-item>

            <!-- 自定义参数 -->
            <el-divider content-position="left">自定义参数</el-divider>

            <el-form-item label="自定义参数">
              <el-input
                v-model="customParamsJson"
                type="textarea"
                :rows="4"
                placeholder='{"max_rounds": 5, "enable_reasoning": true}'
              />
              <el-text size="small" type="info">
                JSON 格式的智能体特定参数
              </el-text>
              <div style="margin-left: 8px">
                <el-button size="small" @click="formatCustomParams">格式化</el-button>
                <el-button size="small" @click="customParamsJson = '{}'">清空</el-button>
              </div>
            </el-form-item>
          </el-form>

          <!-- 操作按钮 -->
          <div style="margin-top: 20px; display: flex; gap: 8px; justify-content: flex-end">
            <el-button @click="exportConfig">
              <el-icon><Download /></el-icon>
              导出配置
            </el-button>
            <el-button @click="showImportDialog">
              <el-icon><Upload /></el-icon>
              导入配置
            </el-button>
            <el-button @click="validateConfig">
              <el-icon><CircleCheck /></el-icon>
              验证配置
            </el-button>
            <el-button type="primary" @click="saveConfig" :loading="saving">
              <el-icon><Check /></el-icon>
              保存配置
            </el-button>
          </div>
        </el-card>

        <!-- 未选择智能体 -->
        <el-card shadow="never" v-else>
          <el-empty description="请从左侧选择一个智能体" />
        </el-card>
      </el-col>
    </el-row>

    <!-- 导入配置对话框 -->
    <el-dialog
      v-model="importDialogVisible"
      title="导入配置"
      width="600px"
    >
      <el-form label-width="100px">
        <el-form-item label="格式">
          <el-radio-group v-model="importFormat">
            <el-radio label="yaml">YAML</el-radio>
            <el-radio label="json">JSON</el-radio>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="配置内容">
          <el-input
            v-model="importText"
            type="textarea"
            :rows="12"
            placeholder="粘贴配置内容"
          />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="importDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="importConfig" :loading="importing">
          导入
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Refresh,
  Check,
  Download,
  Upload,
  CircleCheck
} from '@element-plus/icons-vue'
import LLMConfigSelector from '@/components/LLMConfigSelector.vue'
import {
  getAllAgentConfigs,
  patchAgentConfig,
  applyPreset,
  exportAgentConfig,
  importAgentConfig,
  validateAgentConfig,
  getPresets,
  getAvailableTools
} from '@/api/agentConfig'

// 数据
const loading = ref(false)
const saving = ref(false)
const importing = ref(false)
const agentConfigs = ref({})
const selectedAgent = ref('')
const currentConfig = ref(null)
const presets = ref({})
const applyingPreset = ref('')
const availableTools = ref([]) // 可用工具列表

// 导入对话框
const importDialogVisible = ref(false)
const importFormat = ref('yaml')
const importText = ref('')

// JSON 字段
const customParamsJson = ref('{}')

// 计算属性
const getPresetLabel = (key) => {
  const labels = {
    fast: 'Fast',
    balanced: 'Balanced',
    accurate: 'Accurate',
    creative: 'Creative',
    cheap: 'Cheap'
  }
  return labels[key] || key
}

// 按分类组织工具
const toolCategories = computed(() => {
  const categories = {
    search: { name: 'search', label: '🔍 基础检索工具', tools: [] },
    analysis: { name: 'analysis', label: '📊 高级分析工具', tools: [] },
    other: { name: 'other', label: '🔧 其他工具', tools: [] }
  }

  availableTools.value.forEach(tool => {
    const category = tool.category || 'other'
    if (categories[category]) {
      categories[category].tools.push(tool)
    }
  })

  // 只返回有工具的分类
  return Object.values(categories).filter(cat => cat.tools.length > 0)
})

// 方法
const loadConfigs = async () => {
  loading.value = true
  try {
    const res = await getAllAgentConfigs()
    if (res.success) {
      agentConfigs.value = res.data
      ElMessage.success('配置加载成功')

      // 如果有选中的智能体，刷新其配置
      if (selectedAgent.value && agentConfigs.value[selectedAgent.value]) {
        currentConfig.value = JSON.parse(JSON.stringify(agentConfigs.value[selectedAgent.value]))
        syncJsonFields()
      }
    }
  } catch (error) {
    ElMessage.error('加载配置失败: ' + error.message)
  } finally {
    loading.value = false
  }
}

const loadPresets = async () => {
  try {
    const res = await getPresets()
    if (res.success) {
      presets.value = res.data
    }
  } catch (error) {
    console.error('加载预设失败:', error)
  }
}

const loadAvailableTools = async () => {
  try {
    const res = await getAvailableTools()
    if (res.success) {
      availableTools.value = res.data
    }
  } catch (error) {
    console.error('加载工具列表失败:', error)
    ElMessage.error('加载工具列表失败')
  }
}

const onSelectAgent = (agentName) => {
  selectedAgent.value = agentName
  currentConfig.value = JSON.parse(JSON.stringify(agentConfigs.value[agentName]))
  syncJsonFields()
}

const syncJsonFields = () => {
  if (!currentConfig.value) return

  // 同步自定义参数
  customParamsJson.value = JSON.stringify(
    currentConfig.value.custom_params || {},
    null,
    2
  )
}

const saveConfig = async () => {
  if (!selectedAgent.value || !currentConfig.value) {
    ElMessage.warning('请选择智能体')
    return
  }

  saving.value = true
  try {
    // 解析自定义参数 JSON
    try {
      currentConfig.value.custom_params = JSON.parse(customParamsJson.value)
    } catch (e) {
      ElMessage.error('自定义参数 JSON 格式错误')
      saving.value = false
      return
    }

    // 保存配置
    const res = await patchAgentConfig(selectedAgent.value, currentConfig.value)
    if (res.success) {
      ElMessage.success('配置保存成功')
      await loadConfigs()
    }
  } catch (error) {
    ElMessage.error('保存配置失败: ' + error.message)
  } finally {
    saving.value = false
  }
}

const applyPresetConfig = async (presetKey) => {
  if (!selectedAgent.value) {
    ElMessage.warning('请选择智能体')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定要应用 ${getPresetLabel(presetKey)} 预设吗？这将覆盖当前的 LLM 配置。`,
      '应用预设',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    applyingPreset.value = presetKey
    const res = await applyPreset(selectedAgent.value, presetKey)
    if (res.success) {
      ElMessage.success('预设应用成功')
      await loadConfigs()
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('应用预设失败: ' + error.message)
    }
  } finally {
    applyingPreset.value = ''
  }
}

const exportConfig = async () => {
  if (!selectedAgent.value) {
    ElMessage.warning('请选择智能体')
    return
  }

  try {
    const format = await ElMessageBox.confirm(
      '选择导出格式',
      '导出配置',
      {
        distinguishCancelAndClose: true,
        confirmButtonText: 'YAML',
        cancelButtonText: 'JSON',
        type: 'info'
      }
    ).then(() => 'yaml').catch((action) => {
      if (action === 'cancel') return 'json'
      throw action
    })

    const configText = await exportAgentConfig(selectedAgent.value, format)

    // 下载文件
    const blob = new Blob([configText], { type: 'text/plain' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${selectedAgent.value}_config.${format}`
    a.click()
    window.URL.revokeObjectURL(url)

    ElMessage.success('配置已导出')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error('导出配置失败: ' + error.message)
    }
  }
}

const showImportDialog = () => {
  importDialogVisible.value = true
  importText.value = ''
}

const importConfig = async () => {
  if (!selectedAgent.value) {
    ElMessage.warning('请选择智能体')
    return
  }

  if (!importText.value.trim()) {
    ElMessage.warning('请输入配置内容')
    return
  }

  importing.value = true
  try {
    const res = await importAgentConfig(
      selectedAgent.value,
      importText.value,
      importFormat.value
    )
    if (res.success) {
      ElMessage.success('配置导入成功')
      importDialogVisible.value = false
      await loadConfigs()
    }
  } catch (error) {
    ElMessage.error('导入配置失败: ' + error.message)
  } finally {
    importing.value = false
  }
}

const validateConfig = async () => {
  if (!selectedAgent.value) {
    ElMessage.warning('请选择智能体')
    return
  }

  try {
    const res = await validateAgentConfig(selectedAgent.value)
    if (res.success) {
      if (res.data.valid) {
        ElMessage.success('配置验证通过')
      } else {
        ElMessage.error('配置验证失败: ' + res.data.error)
      }
    }
  } catch (error) {
    ElMessage.error('验证失败: ' + error.message)
  }
}

const formatCustomParams = () => {
  try {
    const obj = JSON.parse(customParamsJson.value)
    customParamsJson.value = JSON.stringify(obj, null, 2)
    ElMessage.success('格式化成功')
  } catch (e) {
    ElMessage.error('JSON 格式错误')
  }
}

// 生命周期
onMounted(() => {
  loadConfigs()
  loadPresets()
  loadAvailableTools()
})
</script>

<style scoped>
.agent-config-container {
  padding: 20px;
}

.page-header {
  margin-bottom: 20px;
}

.page-header h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 500;
}

.page-subtitle {
  margin: 8px 0 0 0;
  color: #666;
  font-size: 14px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.left-sidebar {
  height: calc(100vh - 140px);
  overflow-y: auto;
}

.agent-item {
  width: 100%;
}

.agent-info {
  display: flex;
  align-items: center;
  margin-bottom: 4px;
}

.agent-name {
  font-weight: 500;
}

.agent-desc {
  font-size: 12px;
  color: #999;
  line-height: 1.4;
}

.presets-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

:deep(.presets-grid .el-button+.el-button) {
  margin: 0;
}

.presets-grid .el-button {
  width: 100%;
}

:deep(.el-menu) {
  border: none;
}

:deep(.el-menu-item) {
  height: auto;
  line-height: normal;
  padding: 12px 20px;
}

:deep(.el-divider__text) {
  font-weight: 500;
  color: #303133;
}
</style>
