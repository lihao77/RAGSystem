<template>
  <div class="agent-config-container">
    <div class="page-header">
      <h1>智能体配置管理</h1>
      <p class="page-subtitle">为每个智能体配置独立的 LLM、工具、Skills 与 MCP 服务</p>
    </div>

    <el-row :gutter="16">
      <!-- 左侧：智能体列表 -->
      <el-col :span="8" class="left-sidebar">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>智能体列表</span>
              <div>
                <el-button size="small" type="primary" @click="showCreateDialog">
                  <el-icon><Plus /></el-icon>
                  新建
                </el-button>
                <el-button size="small" @click="loadConfigs" :loading="loading">
                  <el-icon><Refresh /></el-icon>
                  刷新
                </el-button>
              </div>
            </div>
          </template>

          <el-menu :default-active="selectedAgent" @select="onSelectAgent">
            <el-menu-item
              v-for="(config, name) in filteredAgentConfigs"
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

          <el-empty v-if="Object.keys(filteredAgentConfigs).length === 0" description="暂无智能体配置" />
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
                placeholder="选择工具（不选表示不启用任何工具）"
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
              <el-checkbox
                v-if="currentConfig.custom_params?.behavior"
                v-model="currentConfig.custom_params.behavior.auto_execute_tools"
                style="margin-top: 8px"
              >
                自动执行工具调用
              </el-checkbox>
              <el-alert
                type="info"
                :closable="false"
                style="margin-top: 8px"
              >
                <template #default>
                  <div style="font-size: 12px">
                    <strong>工具启用逻辑：</strong>
                    <ul style="margin: 4px 0 0 0; padding-left: 20px">
                      <li><strong>不选择任何工具</strong> = 不启用任何工具</li>
                      <li><strong>选择特定工具</strong> = 仅启用选中的工具</li>
                    </ul>
                  </div>
                </template>
              </el-alert>
            </el-form-item>

            <!-- Skills 配置 -->
            <el-divider content-position="left">Skills 配置</el-divider>

            <el-alert
              title="Skills 配置说明"
              type="info"
              :closable="false"
              style="margin-bottom: 16px"
            >
              Skills 是 Markdown 格式的领域知识指南，教 AI 如何执行特定任务。
              <ul style="margin: 8px 0 0 0; padding-left: 20px">
                <li><strong>渐进式披露</strong>: 只有当 AI 判断需要时才激活 Skill</li>
                <li><strong>工具自动注入</strong>: 启用 Skills 后，系统自动添加 3 个工具：activate_skill、load_skill_resource、execute_skill_script</li>
                <li><strong>不选择 = 不启用任何 Skill</strong></li>
              </ul>
            </el-alert>

            <el-form-item label="启用的 Skills">
              <el-select
                v-model="currentConfig.skills.enabled_skills"
                multiple
                placeholder="选择启用的 Skills（留空表示不启用任何 Skill）"
                style="width: 100%"
                clearable
                filterable
              >
                <el-option
                  v-for="skill in availableSkills"
                  :key="skill.name"
                  :label="skill.display_name || skill.name"
                  :value="skill.name"
                >
                  <div style="display: flex; justify-content: space-between; align-items: center">
                    <span>{{ skill.display_name || skill.name }}</span>
                    <el-tag size="small" type="info" style="margin-left: 8px">{{ skill.name }}</el-tag>
                  </div>
                  <div style="font-size: 12px; color: #999; margin-top: 4px">
                    {{ skill.description }}
                  </div>
                </el-option>
              </el-select>
              <el-alert
                type="info"
                :closable="false"
                style="margin-top: 8px"
              >
                <template #default>
                  <div style="font-size: 12px">
                    <strong>Skills 启用逻辑：</strong>
                    <ul style="margin: 4px 0 0 0; padding-left: 20px">
                      <li>不选择任何 Skill = 不启用 Skills 功能（默认）</li>
                      <li>选择特定 Skill = 启用选中的 Skills，并自动注入 3 个系统工具</li>
                      <li>AI 根据任务场景自主判断是否激活 Skill</li>
                    </ul>
                  </div>
                </template>
              </el-alert>
            </el-form-item>

            <el-divider content-position="left">MCP 服务配置</el-divider>

            <el-alert
              title="MCP 配置说明"
              type="info"
              :closable="false"
              style="margin-bottom: 16px"
            >
              为当前 Agent 选择可访问的 MCP Server。保存后，已连接且可发现工具的服务会在 Agent 加载时自动注入。
            </el-alert>

            <el-form-item label="启用的 MCP 服务">
              <el-select
                v-model="currentConfig.mcp.enabled_servers"
                multiple
                placeholder="选择可授权给当前 Agent 的 MCP 服务"
                style="width: 100%"
                clearable
                filterable
              >
                <el-option
                  v-for="server in availableMCPServers"
                  :key="server.name"
                  :label="server.display_name || server.name"
                  :value="server.name"
                  :disabled="!server.enabled"
                >
                  <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px">
                    <span>{{ server.display_name || server.name }}</span>
                    <div style="display: inline-flex; gap: 6px; align-items: center">
                      <el-tag size="small" type="info">{{ server.transport || 'stdio' }}</el-tag>
                      <el-tag size="small" :type="server.status === 'connected' ? 'success' : server.status === 'error' ? 'danger' : 'warning'">
                        {{ server.status || 'unknown' }}
                      </el-tag>
                    </div>
                  </div>
                  <div style="font-size: 12px; color: #999; margin-top: 4px">
                    {{ server.name }} · 工具 {{ server.tool_count || 0 }} 个<span v-if="server.error_message"> · {{ server.error_message }}</span>
                  </div>
                </el-option>
              </el-select>
              <el-alert
                type="info"
                :closable="false"
                style="margin-top: 8px"
              >
                <template #default>
                  <div style="font-size: 12px">
                    <strong>MCP 启用逻辑：</strong>
                    <ul style="margin: 4px 0 0 0; padding-left: 20px">
                      <li>不选择任何 MCP 服务 = 不注入 MCP 工具</li>
                      <li>选择服务后，只有已连接且能发现工具的服务会真正注入</li>
                      <li>禁用状态的 MCP 服务不可选</li>
                    </ul>
                  </div>
                </template>
              </el-alert>
            </el-form-item>

            <!-- 行为配置 -->
            <el-divider content-position="left">行为配置</el-divider>

            <template v-if="currentConfig.custom_params?.behavior">
              <el-form-item label="系统提示词">
                <el-input
                  v-model="currentConfig.custom_params.behavior.system_prompt"
                  type="textarea"
                  :rows="6"
                  placeholder="定义智能体的角色、性格和任务目标..."
                />
              </el-form-item>

              <el-form-item label="最大对话轮数">
                <el-input-number
                  v-model="currentConfig.custom_params.behavior.max_rounds"
                  :min="1"
                  :max="50"
                />
              </el-form-item>
            </template>

            <!-- 自定义参数 -->
            <el-divider content-position="left">高级参数 (JSON)</el-divider>

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
             <el-button type="danger" @click="handleDeleteAgent" :loading="deleting" plain>
              <el-icon><Delete /></el-icon>
              删除
            </el-button>
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

    <!-- 新建智能体对话框 -->
    <el-dialog
      v-model="createDialogVisible"
      title="新建智能体"
      width="500px"
    >
      <el-form
        ref="newAgentFormRef"
        :model="newAgentForm"
        :rules="createRules"
        label-width="100px"
      >
        <el-form-item label="智能体ID" prop="agent_name">
          <el-input
            v-model="newAgentForm.agent_name"
            placeholder="例如: translation_agent (小写字母开头，仅限字母数字下划线)"
          />
        </el-form-item>
        <el-form-item label="显示名称" prop="display_name">
          <el-input
            v-model="newAgentForm.display_name"
            placeholder="例如: 翻译助手"
          />
        </el-form-item>
        <el-form-item label="描述" prop="description">
          <el-input
            v-model="newAgentForm.description"
            type="textarea"
            :rows="3"
            placeholder="简要描述该智能体的功能"
          />
        </el-form-item>
        <el-form-item label="系统提示词" prop="system_prompt">
          <el-input
            v-model="newAgentForm.system_prompt"
            type="textarea"
            :rows="5"
            placeholder="定义智能体的角色和行为，例如：'你是一个专业的翻译助手...'"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="handleCreateAgent" :loading="creating">
          创建
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
  CircleCheck,
  Plus,
  Delete
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
  getAvailableTools,
  getAvailableSkills,
  getAvailableMCPServers,
  createAgent,
  deleteAgent
} from '@/api/agentConfig'

// 数据
const loading = ref(false)
const saving = ref(false)
const importing = ref(false)
const creating = ref(false)
const deleting = ref(false)
const agentConfigs = ref({})
const selectedAgent = ref('')
const currentConfig = ref(null)
const presets = ref({})
const applyingPreset = ref('')
const availableTools = ref([]) // 可用工具列表
const availableSkills = ref([]) // 可用 Skills 列表
const availableMCPServers = ref([]) // MCP servers

// 导入对话框
const importDialogVisible = ref(false)
const importFormat = ref('yaml')
const importText = ref('')

// 新建对话框
const createDialogVisible = ref(false)
const newAgentForm = reactive({
  agent_name: '',
  display_name: '',
  description: '',
  type: 'react',
  system_prompt: ''
})
const newAgentFormRef = ref(null)
const createRules = {
  agent_name: [
    { required: true, message: '请输入智能体ID', trigger: 'blur' },
    { pattern: /^[a-z][a-z0-9_]*$/, message: '只能包含小写字母、数字和下划线，且以字母开头', trigger: 'blur' }
  ],
  display_name: [
    { required: true, message: '请输入显示名称', trigger: 'blur' }
  ],
  system_prompt: [
    { required: true, message: '请输入系统提示词', trigger: 'blur' }
  ]
}

// JSON 字段
const customParamsJson = ref('{}')

// 计算属性：过滤掉系统智能体（master_agent）
const filteredAgentConfigs = computed(() => {
  const configs = {}
  for (const [name, config] of Object.entries(agentConfigs.value)) {
    // 排除 master_agent（系统智能体，不可配置）
    if (name !== 'master_agent') {
      configs[name] = config
    }
  }
  return configs
})

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

const loadAvailableSkills = async () => {
  try {
    const res = await getAvailableSkills()
    if (res.success) {
      availableSkills.value = res.data
    }
  } catch (error) {
    console.error('加载 Skills 列表失败:', error)
    ElMessage.error('加载 Skills 列表失败')
  }
}


const loadAvailableMCPServers = async () => {
  try {
    const res = await getAvailableMCPServers()
    if (res.success) {
      availableMCPServers.value = res.data
    }
  } catch (error) {
    console.error('加载 MCP Server 列表失败:', error)
    ElMessage.error('加载 MCP Server 列表失败')
  }
}
const onSelectAgent = (agentName) => {
  selectedAgent.value = agentName
  currentConfig.value = JSON.parse(JSON.stringify(agentConfigs.value[agentName]))
  syncJsonFields()
}

const syncJsonFields = () => {
  if (!currentConfig.value) return

  // 1. 确保 custom_params 存在
  if (!currentConfig.value.custom_params) {
    currentConfig.value.custom_params = {}
  }

  // 2. 确保 tools 配置存在
  if (!currentConfig.value.tools) {
    currentConfig.value.tools = { enabled_tools: [] }
  }

  // 3. 确保 skills 配置存在
  if (!currentConfig.value.skills) {
    currentConfig.value.skills = { enabled_skills: [], auto_inject: true }
  } else if (typeof currentConfig.value.skills.auto_inject !== 'boolean') {
    currentConfig.value.skills.auto_inject = true
  }

  // 4. 确保 mcp 配置存在
  if (!currentConfig.value.mcp) {
    currentConfig.value.mcp = { enabled_servers: [] }
  }

  // 4. 确保 generic 类型的智能体有 behavior 对象
  const isGeneric = currentConfig.value.custom_params.type === 'generic' || !currentConfig.value.custom_params.type
  if (isGeneric && !currentConfig.value.custom_params.behavior) {
    currentConfig.value.custom_params.behavior = {
      system_prompt: '',
      max_rounds: 10,
      auto_execute_tools: true
    }
  }

  // 3. 将其余参数显示在 JSON 编辑器中（排除 behavior 中已提取显示的字段）
  // 实际上这里我们仍然把整个 custom_params 转为 JSON 显示在"高级参数"里，
  // 这样用户可以改 JSON 也可以改表单，两者是绑定的（因为 v-model 指向同一个引用）
  // 不过为了避免混淆，我们可以只在 JSON 里显示那些"未被提取"的字段？
  // 鉴于实现复杂性，目前保持 JSON 显示完整内容，但用户主要操作表单即可。

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
    // 1. 先从 JSON 编辑器更新 custom_params（防止用户直接改了 JSON）
    try {
      const jsonParams = JSON.parse(customParamsJson.value)

      // 2. 合并表单中的修改（如果有）
      // 注意：由于表单直接 v-model 绑定到了 currentConfig.custom_params.behavior 上，
      // 如果用户只改了表单没改 JSON 框，那么 currentConfig 里的数据是最新的。
      // 如果用户改了 JSON 框，那么 JSON 框是最新的。
      // 为了避免冲突，我们以 JSON 框的内容为准，重新赋值给 currentConfig
      currentConfig.value.custom_params = jsonParams

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

const showCreateDialog = () => {
  newAgentForm.agent_name = ''
  newAgentForm.display_name = ''
  newAgentForm.description = ''
  newAgentForm.type = 'react'
  newAgentForm.system_prompt = ''
  createDialogVisible.value = true
}

const handleCreateAgent = async () => {
  if (!newAgentFormRef.value) return

  await newAgentFormRef.value.validate(async (valid) => {
    if (valid) {
      creating.value = true
      try {
        const payload = {
          ...newAgentForm,
          enabled: true,
          custom_params: {
            type: newAgentForm.type,
            behavior: {
              system_prompt: newAgentForm.system_prompt,
              max_rounds: 10,
              auto_execute_tools: true
            }
          }
        }

        // 移除临时字段，避免污染配置
        delete payload.system_prompt
        delete payload.type

        const res = await createAgent(payload)
        if (res.success) {
          ElMessage.success('智能体创建成功')
          createDialogVisible.value = false
          await loadConfigs()
          // 选中新创建的智能体
          selectedAgent.value = newAgentForm.agent_name
          currentConfig.value = JSON.parse(JSON.stringify(agentConfigs.value[newAgentForm.agent_name]))
          syncJsonFields()
        }
      } catch (error) {
        ElMessage.error('创建失败: ' + error.message)
      } finally {
        creating.value = false
      }
    }
  })
}

const handleDeleteAgent = async () => {
  if (!selectedAgent.value) return

  try {
    await ElMessageBox.confirm(
      `确定要删除智能体 "${currentConfig.value.display_name || selectedAgent.value}" 吗？此操作不可恢复。`,
      '删除确认',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger'
      }
    )

    deleting.value = true
    const res = await deleteAgent(selectedAgent.value)
    if (res.success) {
      ElMessage.success('智能体已删除')
      selectedAgent.value = ''
      currentConfig.value = null
      await loadConfigs()
    }
  } catch (error) {
    if (error !== 'cancel') {
      ElMessage.error('删除失败: ' + error.message)
    }
  } finally {
    deleting.value = false
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
  loadAvailableSkills()
  loadAvailableMCPServers()
})

// 监听配置对象的变化，实时更新 JSON 视图
watch(
  () => currentConfig.value?.custom_params,
  (newVal) => {
    if (newVal) {
      // 避免 JSON 编辑器输入时产生的循环更新
      // 只有当对象确实发生了非编辑器来源的变更时才更新
      // 简单起见，这里总是更新，但用户体验上可能需要注意
      // 为了更好的体验，我们只在非编辑模式下同步？
      // 或者：既然我们有 JSON 编辑器，也许不需要实时双向绑定？
      // 策略：单向流。加载时 Object -> JSON。
      // 保存时：JSON -> Object。
      // 表单修改时：Object 修改。此时需要同步到 JSON。
      customParamsJson.value = JSON.stringify(newVal, null, 2)
    }
  },
  { deep: true }
)
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
