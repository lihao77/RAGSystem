<template>
  <div class="mcp-container">
    <div class="page-header">
      <h1>MCP 服务管理</h1>
      <p class="page-subtitle">通过模板或官方 MCP Registry 搜索安装服务，并为智能体提供可选服务列表。</p>
    </div>

    <div class="summary-grid">
      <el-card shadow="never" class="summary-card">
        <div class="summary-label">服务总数</div>
        <div class="summary-value">{{ summary.total }}</div>
      </el-card>
      <el-card shadow="never" class="summary-card">
        <div class="summary-label">已连接</div>
        <div class="summary-value">{{ summary.connected }}</div>
      </el-card>
      <el-card shadow="never" class="summary-card">
        <div class="summary-label">已启用</div>
        <div class="summary-value">{{ summary.enabled }}</div>
      </el-card>
      <el-card shadow="never" class="summary-card">
        <div class="summary-label">已发现工具</div>
        <div class="summary-value">{{ summary.tools }}</div>
      </el-card>
    </div>

    <el-row :gutter="16">
      <el-col :span="9">
        <el-card shadow="never" class="panel-card">
          <template #header>
            <div class="card-header">
              <span>模板安装</span>
              <el-button size="small" @click="loadTemplates" :loading="loadingTemplates">刷新模板</el-button>
            </div>
          </template>

          <el-form label-width="120px">
            <el-form-item label="模板">
              <el-select v-model="installForm.template_id" placeholder="选择一个模板" style="width: 100%" @change="handleTemplateChange">
                <el-option
                  v-for="template in templates"
                  :key="template.id"
                  :label="template.display_name"
                  :value="template.id"
                />
              </el-select>
            </el-form-item>

            <el-alert
              v-if="selectedTemplate"
              :title="selectedTemplate.display_name"
              type="info"
              :closable="false"
              style="margin-bottom: 16px"
            >
              <template #default>
                <div>{{ selectedTemplate.description }}</div>
                <div class="hint-text">{{ selectedTemplate.install_hint }}</div>
              </template>
            </el-alert>

            <template v-if="selectedTemplate">
              <el-form-item label="服务名称">
                <el-input v-model="installForm.server_name" placeholder="如 filesystem" />
              </el-form-item>

              <el-form-item label="显示名称">
                <el-input v-model="installForm.display_name" placeholder="前端展示名称" />
              </el-form-item>

              <el-form-item
                v-for="field in selectedTemplate.fields || []"
                :key="field.name"
                :label="field.label"
              >
                <el-input
                  v-model="installForm.options[field.name]"
                  :type="field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'"
                  :show-password="field.type === 'password'"
                  :placeholder="field.placeholder || ''"
                />
                <div v-if="field.help" class="hint-text">{{ field.help }}</div>
              </el-form-item>

              <el-form-item label="启用服务">
                <el-switch v-model="installForm.enabled" />
              </el-form-item>

              <el-form-item label="自动连接">
                <el-switch v-model="installForm.auto_connect" />
              </el-form-item>

              <el-form-item label="超时秒数">
                <el-input-number v-model="installForm.timeout" :min="1" :max="300" />
              </el-form-item>

              <el-form-item label="风险等级">
                <el-select v-model="installForm.risk_level" style="width: 100%">
                  <el-option label="Low" value="low" />
                  <el-option label="Medium" value="medium" />
                  <el-option label="High" value="high" />
                </el-select>
              </el-form-item>

              <el-form-item label="需要审批">
                <el-switch v-model="installForm.requires_approval" />
              </el-form-item>

              <el-form-item>
                <el-button type="primary" :loading="installing" @click="installSelectedTemplate">安装服务</el-button>
                <el-button @click="resetInstallForm">重置</el-button>
              </el-form-item>
            </template>
          </el-form>
        </el-card>

        <el-card shadow="never" class="panel-card registry-card">
          <template #header>
            <div class="card-header">
              <span>MCP Registry</span>
              <el-button size="small" @click="searchRegistryServers" :loading="loadingRegistryResults">刷新搜索</el-button>
            </div>
          </template>

          <div class="registry-toolbar">
            <el-input
              v-model="registrySearch.query"
              placeholder="搜索服务，如 github、filesystem、mysql"
              clearable
              @keyup.enter="searchRegistryServers"
            >
              <template #append>
                <el-button @click="searchRegistryServers" :loading="loadingRegistryResults">搜索</el-button>
              </template>
            </el-input>
            <el-switch v-model="registrySearch.latest_only" active-text="仅最新版本" @change="searchRegistryServers" />
          </div>

          <div v-loading="loadingRegistryResults">
            <el-empty v-if="!registryResults.length" description="暂无 Registry 搜索结果" />

            <div v-for="item in registryResults" :key="`${item.name}-${item.version}`" class="registry-result">
              <div class="registry-result-header">
                <div>
                  <div class="server-title">{{ item.display_name || item.name }}</div>
                  <div class="server-subtitle">{{ item.name }} · v{{ item.version }}</div>
                </div>
                <el-tag v-if="item.latest" type="success">Latest</el-tag>
              </div>

              <div class="registry-description">{{ item.description }}</div>

              <div class="registry-tags">
                <el-tag
                  v-for="option in item.install_options"
                  :key="option.id"
                  size="small"
                  :type="option.supported ? 'info' : 'warning'"
                >
                  {{ option.label }}
                </el-tag>
              </div>

              <div class="action-row">
                <el-button size="small" type="primary" :disabled="!item.installable" @click="handleRegistryInstall(item)">
                  {{ quickInstallButtonText(item) }}
                </el-button>
                <el-button size="small" :disabled="!item.install_options.length" @click="openRegistryInstallDialog(item)">配置安装</el-button>
                <el-button v-if="item.website_url" size="small" link @click="openExternalLink(item.website_url)">官网</el-button>
                <el-button v-if="item.repository_url" size="small" link @click="openExternalLink(item.repository_url)">源码</el-button>
              </div>

              <div v-if="firstUnsupportedReason(item)" class="hint-text">{{ firstUnsupportedReason(item) }}</div>
            </div>

            <div v-if="registryNextCursor" class="registry-load-more">
              <el-button size="small" @click="loadMoreRegistryServers" :loading="loadingMoreRegistry">加载更多</el-button>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="15">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>已安装服务</span>
              <el-button size="small" @click="loadServers" :loading="loadingServers">刷新列表</el-button>
            </div>
          </template>

          <el-table :data="servers" v-loading="loadingServers" empty-text="暂无 MCP 服务" style="width: 100%">
            <el-table-column label="名称" min-width="180">
              <template #default="scope">
                <div class="server-title">{{ scope.row.display_name || scope.row.name }}</div>
                <div class="server-subtitle">{{ scope.row.name }}</div>
              </template>
            </el-table-column>
            <el-table-column label="传输" prop="transport" width="120" />
            <el-table-column label="状态" width="120">
              <template #default="scope">
                <div class="status-cell">
                  <el-tag :type="statusTagType(scope.row.status)">{{ scope.row.status || 'unknown' }}</el-tag>
                  <div v-if="scope.row.error_message" class="error-inline">{{ scope.row.error_message }}</div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="接入信息" min-width="220">
              <template #default="scope">
                <div class="server-subtitle">{{ scope.row.transport === 'stdio' ? (scope.row.command || '-') : (scope.row.url || '-') }}</div>
                <div class="hint-text">{{ scope.row.transport === 'stdio' ? formatArgs(scope.row.args) : formatHeaders(scope.row.headers) }}</div>
              </template>
            </el-table-column>
            <el-table-column label="工具数" prop="tool_count" width="100" />
            <el-table-column label="启用" width="90">
              <template #default="scope">
                <el-tag :type="scope.row.enabled ? 'success' : 'info'">{{ scope.row.enabled ? '是' : '否' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" min-width="320">
              <template #default="scope">
                <div class="action-row">
                  <el-button size="small" :disabled="!scope.row.enabled || scope.row.status === 'connected'" @click="handleConnect(scope.row)">连接</el-button>
                  <el-button size="small" :disabled="scope.row.status !== 'connected'" @click="handleDisconnect(scope.row)">断开</el-button>
                  <el-button size="small" @click="handleTest(scope.row)">测试</el-button>
                  <el-button size="small" :disabled="(scope.row.tool_count || 0) === 0" @click="showTools(scope.row)">工具</el-button>
                  <el-button size="small" @click="openEditDialog(scope.row)">编辑</el-button>
                  <el-button size="small" type="danger" @click="handleDelete(scope.row)">删除</el-button>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="registryInstallDialogVisible" title="从 MCP Registry 安装" width="760px">
      <el-form v-if="registryInstallDialogVisible && selectedRegistryServer" label-width="140px">
        <el-alert :title="selectedRegistryServer.display_name || selectedRegistryServer.name" type="info" :closable="false" style="margin-bottom: 16px">
          <template #default>
            <div>{{ selectedRegistryServer.description }}</div>
            <div class="hint-text">{{ selectedRegistryServer.name }} · v{{ selectedRegistryServer.version }}</div>
          </template>
        </el-alert>

        <el-form-item label="安装方式">
          <el-select v-model="registryInstallForm.option_id" style="width: 100%" @change="handleRegistryOptionChange">
            <el-option
              v-for="option in selectedRegistryServer.install_options"
              :key="option.id"
              :label="option.supported ? option.label : `${option.label}（暂不支持）`"
              :value="option.id"
              :disabled="!option.supported"
            />
          </el-select>
          <div v-if="selectedRegistryOption?.command_preview" class="hint-text">命令预览：{{ selectedRegistryOption.command_preview }}</div>
          <div v-if="selectedRegistryOption?.url_preview" class="hint-text">地址预览：{{ selectedRegistryOption.url_preview }}</div>
          <div v-if="selectedRegistryOption?.unsupported_reason" class="error-inline">{{ selectedRegistryOption.unsupported_reason }}</div>
        </el-form-item>

        <el-form-item label="服务名称">
          <el-input v-model="registryInstallForm.server_name" placeholder="本地唯一标识，如 github_mcp" />
        </el-form-item>

        <el-form-item label="显示名称">
          <el-input v-model="registryInstallForm.display_name" placeholder="前端展示名称" />
        </el-form-item>

        <el-form-item
          v-for="field in selectedRegistryFields"
          :key="field.key"
          :label="field.label"
        >
          <template v-if="field.format === 'boolean'">
            <el-switch v-model="registryInstallForm.input_values[field.key]" />
          </template>
          <template v-else-if="field.format === 'number'">
            <el-input-number v-model="registryInstallForm.input_values[field.key]" :min="0" style="width: 100%" />
          </template>
          <template v-else>
            <el-input
              v-model="registryInstallForm.input_values[field.key]"
              :type="field.secret ? 'password' : field.format === 'filepath' ? 'text' : 'text'"
              :show-password="field.secret"
              :placeholder="field.placeholder || ''"
            />
          </template>
          <div class="hint-text">
            <span v-if="field.description">{{ field.description }}</span>
            <span v-if="field.repeated"> 多值请用英文逗号分隔。</span>
            <span v-if="field.required"> 必填。</span>
          </div>
        </el-form-item>

        <el-form-item label="启用服务">
          <el-switch v-model="registryInstallForm.enabled" />
        </el-form-item>

        <el-form-item label="自动连接">
          <el-switch v-model="registryInstallForm.auto_connect" />
        </el-form-item>

        <el-form-item label="超时秒数">
          <el-input-number v-model="registryInstallForm.timeout" :min="1" :max="300" />
        </el-form-item>

        <el-form-item label="风险等级">
          <el-select v-model="registryInstallForm.risk_level" style="width: 100%">
            <el-option label="Low" value="low" />
            <el-option label="Medium" value="medium" />
            <el-option label="High" value="high" />
          </el-select>
        </el-form-item>

        <el-form-item label="需要审批">
          <el-switch v-model="registryInstallForm.requires_approval" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="registryInstallDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="installingRegistry" :disabled="!selectedRegistryOption?.supported" @click="submitRegistryInstall()">
          安装服务
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="editDialogVisible" title="编辑 MCP 服务" width="720px">
      <el-form v-if="editForm" label-width="120px">
        <el-form-item label="服务名称">
          <el-input v-model="editForm.name" disabled />
        </el-form-item>
        <el-form-item label="显示名称">
          <el-input v-model="editForm.display_name" />
        </el-form-item>
        <el-form-item label="传输方式">
          <el-select v-model="editForm.transport" style="width: 100%">
            <el-option label="stdio" value="stdio" />
            <el-option label="sse" value="sse" />
            <el-option label="streamable_http" value="streamable_http" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="editForm.transport === 'stdio'" label="命令">
          <el-input v-model="editForm.command" placeholder="如 npx" />
        </el-form-item>
        <el-form-item v-if="editForm.transport === 'stdio'" label="参数(JSON)">
          <el-input v-model="editForm.argsJson" type="textarea" :rows="4" />
        </el-form-item>
        <el-form-item v-if="editForm.transport === 'stdio'" label="环境变量(JSON)">
          <el-input v-model="editForm.envJson" type="textarea" :rows="4" />
        </el-form-item>
        <el-form-item v-else label="URL">
          <el-input v-model="editForm.url" placeholder="http://localhost:8080/sse" />
        </el-form-item>
        <el-form-item v-if="editForm.transport !== 'stdio'" label="Headers(JSON)">
          <el-input v-model="editForm.headersJson" type="textarea" :rows="4" />
        </el-form-item>
        <el-form-item label="启用服务">
          <el-switch v-model="editForm.enabled" />
        </el-form-item>
        <el-form-item label="自动连接">
          <el-switch v-model="editForm.auto_connect" />
        </el-form-item>
        <el-form-item label="超时秒数">
          <el-input-number v-model="editForm.timeout" :min="1" :max="300" />
        </el-form-item>
        <el-form-item label="风险等级">
          <el-select v-model="editForm.risk_level" style="width: 100%">
            <el-option label="Low" value="low" />
            <el-option label="Medium" value="medium" />
            <el-option label="High" value="high" />
          </el-select>
        </el-form-item>
        <el-form-item label="需要审批">
          <el-switch v-model="editForm.requires_approval" />
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="editDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="savingEdit" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="toolsDialogVisible" title="MCP 工具列表" width="720px">
      <el-table :data="serverTools" empty-text="暂无工具">
        <el-table-column label="工具名" min-width="220">
          <template #default="scope">
            {{ scope.row.function?.name || '-' }}
          </template>
        </el-table-column>
        <el-table-column label="描述" min-width="320">
          <template #default="scope">
            {{ scope.row.function?.description || '-' }}
          </template>
        </el-table-column>
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  connectMCPServer,
  deleteMCPServer,
  disconnectMCPServer,
  getMCPServerTools,
  installMCPRegistryServer,
  installMCPServerFromTemplate,
  listMCPRegistryServers,
  listMCPServers,
  listMCPTemplates,
  testMCPServer,
  updateMCPServer,
} from '@/api/mcpService'

const loadingTemplates = ref(false)
const loadingServers = ref(false)
const loadingRegistryResults = ref(false)
const loadingMoreRegistry = ref(false)
const installing = ref(false)
const installingRegistry = ref(false)
const savingEdit = ref(false)
const templates = ref([])
const servers = ref([])
const registryResults = ref([])
const registryNextCursor = ref('')
const editDialogVisible = ref(false)
const toolsDialogVisible = ref(false)
const registryInstallDialogVisible = ref(false)
const serverTools = ref([])
const selectedRegistryServer = ref(null)

const installForm = reactive({
  template_id: '',
  server_name: '',
  display_name: '',
  enabled: true,
  auto_connect: true,
  timeout: 30,
  risk_level: 'medium',
  requires_approval: false,
  options: {},
})

const registrySearch = reactive({
  query: '',
  latest_only: true,
  limit: 6,
})

const registryInstallForm = reactive({
  option_id: '',
  server_name: '',
  display_name: '',
  enabled: true,
  auto_connect: true,
  timeout: 30,
  risk_level: 'medium',
  requires_approval: false,
  input_values: {},
})

const editForm = ref(null)

const selectedTemplate = computed(() => templates.value.find((template) => template.id === installForm.template_id) || null)
const selectedRegistryOption = computed(() => {
  return selectedRegistryServer.value?.install_options?.find((option) => option.id === registryInstallForm.option_id) || null
})
const selectedRegistryFields = computed(() => selectedRegistryOption.value?.form_fields || [])
const summary = computed(() => ({
  total: servers.value.length,
  connected: servers.value.filter((server) => server.status === 'connected').length,
  enabled: servers.value.filter((server) => server.enabled).length,
  tools: servers.value.reduce((sum, server) => sum + (server.tool_count || 0), 0),
}))

function statusTagType(status) {
  if (status === 'connected') return 'success'
  if (status === 'connecting') return 'warning'
  if (status === 'error') return 'danger'
  return 'info'
}

function formatArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return '无额外参数'
  return args.join(' ')
}

function formatHeaders(headers) {
  const entries = Object.entries(headers || {})
  if (!entries.length) return '远程服务地址'
  return `Headers: ${entries.map(([key]) => key).join(', ')}`
}

function applyTemplateDefaults(template) {
  installForm.server_name = template?.recommended_server_name || ''
  installForm.display_name = template?.defaults?.display_name || template?.display_name || ''
  installForm.enabled = template?.defaults?.enabled ?? true
  installForm.auto_connect = template?.defaults?.auto_connect ?? true
  installForm.timeout = template?.defaults?.timeout ?? 30
  installForm.risk_level = template?.defaults?.risk_level || 'medium'
  installForm.requires_approval = template?.defaults?.requires_approval ?? false
  installForm.options = {}
  ;(template?.fields || []).forEach((field) => {
    installForm.options[field.name] = field.default ?? ''
  })
}

function resetInstallForm() {
  if (selectedTemplate.value) {
    applyTemplateDefaults(selectedTemplate.value)
  } else {
    installForm.template_id = ''
    installForm.server_name = ''
    installForm.display_name = ''
    installForm.enabled = true
    installForm.auto_connect = true
    installForm.timeout = 30
    installForm.risk_level = 'medium'
    installForm.requires_approval = false
    installForm.options = {}
  }
}

function handleTemplateChange(templateId) {
  const template = templates.value.find((item) => item.id === templateId)
  applyTemplateDefaults(template)
}

function defaultFieldValue(field) {
  if (field.default_value !== null && field.default_value !== undefined) {
    return field.default_value
  }
  if (field.format === 'boolean') return false
  return ''
}

function initializeRegistryInputValues(option) {
  const nextValues = {}
  ;(option?.form_fields || []).forEach((field) => {
    nextValues[field.key] = defaultFieldValue(field)
  })
  registryInstallForm.input_values = nextValues
}

function applyRegistryInstallDefaults(server, option) {
  registryInstallForm.option_id = option?.id || ''
  registryInstallForm.server_name = option?.default_server_name || server?.default_server_name || ''
  registryInstallForm.display_name = option?.default_display_name || server?.default_display_name || server?.display_name || ''
  registryInstallForm.enabled = true
  registryInstallForm.auto_connect = true
  registryInstallForm.timeout = option?.default_timeout || 30
  registryInstallForm.risk_level = option?.default_risk_level || 'medium'
  registryInstallForm.requires_approval = option?.default_requires_approval ?? false
  initializeRegistryInputValues(option)
}

function getPreferredInstallOption(server) {
  if (!server) return null
  return server.install_options?.find((option) => option.id === server.preferred_option_id)
    || server.install_options?.find((option) => option.supported)
    || server.install_options?.[0]
    || null
}

function countSupportedInstallOptions(server) {
  return (server?.install_options || []).filter((option) => option.supported).length
}

function canQuickInstall(server) {
  const option = getPreferredInstallOption(server)
  if (!option?.supported) return false
  if (countSupportedInstallOptions(server) !== 1) return false
  return !(option.form_fields || []).some((field) => {
    if (!field.required) return false
    const value = field.default_value
    return value === null || value === undefined || value === ''
  })
}

function quickInstallButtonText(server) {
  return canQuickInstall(server) ? '一键安装' : '安装'
}

function firstUnsupportedReason(server) {
  return server?.install_options?.find((option) => !option.supported)?.unsupported_reason || ''
}

function openExternalLink(url) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

function openRegistryInstallDialog(server) {
  const option = getPreferredInstallOption(server)
  selectedRegistryServer.value = server
  applyRegistryInstallDefaults(server, option)
  registryInstallDialogVisible.value = true
}

function handleRegistryOptionChange(optionId) {
  const option = selectedRegistryServer.value?.install_options?.find((item) => item.id === optionId)
  if (!option) return
  registryInstallForm.timeout = option.default_timeout || registryInstallForm.timeout
  registryInstallForm.risk_level = option.default_risk_level || registryInstallForm.risk_level
  registryInstallForm.requires_approval = option.default_requires_approval ?? registryInstallForm.requires_approval
  initializeRegistryInputValues(option)
}

async function loadTemplates() {
  loadingTemplates.value = true
  try {
    const res = await listMCPTemplates()
    templates.value = res.data || []
    if (!installForm.template_id && templates.value.length > 0) {
      installForm.template_id = templates.value[0].id
      applyTemplateDefaults(templates.value[0])
    }
  } catch (error) {
    ElMessage.error(`加载 MCP 模板失败: ${error.message}`)
  } finally {
    loadingTemplates.value = false
  }
}

async function loadServers() {
  loadingServers.value = true
  try {
    const res = await listMCPServers()
    servers.value = res.data || []
  } catch (error) {
    ElMessage.error(`加载 MCP 服务失败: ${error.message}`)
  } finally {
    loadingServers.value = false
  }
}

async function searchRegistryServers({ append = false } = {}) {
  if (append && !registryNextCursor.value) return

  const loadingRef = append ? loadingMoreRegistry : loadingRegistryResults
  loadingRef.value = true
  try {
    const res = await listMCPRegistryServers({
      search: registrySearch.query,
      limit: registrySearch.limit,
      cursor: append ? registryNextCursor.value : '',
      latest_only: registrySearch.latest_only,
    })
    const items = res.data?.items || []
    registryResults.value = append ? [...registryResults.value, ...items] : items
    registryNextCursor.value = res.data?.next_cursor || ''
  } catch (error) {
    ElMessage.error(`搜索 MCP Registry 失败: ${error.message}`)
  } finally {
    loadingRef.value = false
  }
}

async function loadMoreRegistryServers() {
  await searchRegistryServers({ append: true })
}

async function installSelectedTemplate() {
  if (!installForm.template_id) {
    ElMessage.warning('请先选择一个模板')
    return
  }

  const missingField = (selectedTemplate.value?.fields || []).find((field) => {
    if (!field.required) return false
    const value = installForm.options[field.name]
    return value == null || String(value).trim() === ''
  })
  if (missingField) {
    ElMessage.warning(`请填写 ${missingField.label}`)
    return
  }

  installing.value = true
  try {
    const res = await installMCPServerFromTemplate({
      template_id: installForm.template_id,
      server_name: installForm.server_name,
      display_name: installForm.display_name,
      enabled: installForm.enabled,
      auto_connect: installForm.auto_connect,
      timeout: installForm.timeout,
      risk_level: installForm.risk_level,
      requires_approval: installForm.requires_approval,
      options: installForm.options,
    })
    if (res.success) {
      ElMessage.success(res.message || 'MCP 服务安装成功')
      await loadServers()
    }
  } catch (error) {
    ElMessage.error(`安装失败: ${error.message}`)
  } finally {
    installing.value = false
  }
}

async function submitRegistryInstall(customPayload = null) {
  const option = selectedRegistryOption.value || customPayload?.install_option
  if (!option) {
    ElMessage.warning('请选择一个可用的安装方式')
    return
  }
  if (!option.supported) {
    ElMessage.warning(option.unsupported_reason || '当前安装方式暂不支持')
    return
  }

  const payload = customPayload || {
    install_option: option,
    server_name: registryInstallForm.server_name,
    display_name: registryInstallForm.display_name,
    enabled: registryInstallForm.enabled,
    auto_connect: registryInstallForm.auto_connect,
    timeout: registryInstallForm.timeout,
    risk_level: registryInstallForm.risk_level,
    requires_approval: registryInstallForm.requires_approval,
    input_values: registryInstallForm.input_values,
  }

  const missingField = (option.form_fields || []).find((field) => {
    if (!field.required) return false
    const value = payload.input_values?.[field.key]
    return value === null || value === undefined || value === ''
  })
  if (missingField) {
    ElMessage.warning(`请填写 ${missingField.label}`)
    return
  }

  installingRegistry.value = true
  try {
    const res = await installMCPRegistryServer(payload)
    if (res.success) {
      ElMessage.success(res.message || 'MCP 服务安装成功')
      registryInstallDialogVisible.value = false
      await loadServers()
    }
  } catch (error) {
    ElMessage.error(`Registry 安装失败: ${error.message}`)
  } finally {
    installingRegistry.value = false
  }
}

async function handleRegistryInstall(server) {
  const option = getPreferredInstallOption(server)
  if (!option?.supported) {
    ElMessage.warning(firstUnsupportedReason(server) || '当前没有可用的安装方式')
    return
  }

  if (!canQuickInstall(server)) {
    openRegistryInstallDialog(server)
    return
  }

  await submitRegistryInstall({
    install_option: option,
    server_name: option.default_server_name || server.default_server_name,
    display_name: option.default_display_name || server.default_display_name,
    enabled: true,
    auto_connect: true,
    timeout: option.default_timeout || 30,
    risk_level: option.default_risk_level || 'medium',
    requires_approval: option.default_requires_approval ?? false,
    input_values: Object.fromEntries((option.form_fields || []).map((field) => [field.key, defaultFieldValue(field)])),
  })
}

function openEditDialog(server) {
  editForm.value = {
    name: server.name,
    display_name: server.display_name || '',
    transport: server.transport,
    command: server.command || '',
    argsJson: JSON.stringify(server.args || [], null, 2),
    envJson: JSON.stringify(server.env || {}, null, 2),
    headersJson: JSON.stringify(server.headers || {}, null, 2),
    url: server.url || '',
    enabled: !!server.enabled,
    auto_connect: !!server.auto_connect,
    timeout: server.timeout || 30,
    risk_level: server.risk_level || 'medium',
    requires_approval: !!server.requires_approval,
  }
  editDialogVisible.value = true
}

async function saveEdit() {
  if (!editForm.value) return

  savingEdit.value = true
  try {
    let parsedArgs = []
    let parsedEnv = {}
    let parsedHeaders = {}

    if (editForm.value.transport === 'stdio') {
      try {
        parsedArgs = JSON.parse(editForm.value.argsJson || '[]')
      } catch (error) {
        throw new Error('参数(JSON) 不是合法的 JSON 数组')
      }

      try {
        parsedEnv = JSON.parse(editForm.value.envJson || '{}')
      } catch (error) {
        throw new Error('环境变量(JSON) 不是合法的 JSON 对象')
      }
    } else {
      try {
        parsedHeaders = JSON.parse(editForm.value.headersJson || '{}')
      } catch (error) {
        throw new Error('Headers(JSON) 不是合法的 JSON 对象')
      }
    }

    const payload = {
      display_name: editForm.value.display_name,
      transport: editForm.value.transport,
      enabled: editForm.value.enabled,
      auto_connect: editForm.value.auto_connect,
      timeout: editForm.value.timeout,
      risk_level: editForm.value.risk_level,
      requires_approval: editForm.value.requires_approval,
      command: editForm.value.transport === 'stdio' ? editForm.value.command : null,
      args: editForm.value.transport === 'stdio' ? parsedArgs : [],
      env: editForm.value.transport === 'stdio' ? parsedEnv : {},
      headers: editForm.value.transport === 'stdio' ? {} : parsedHeaders,
      url: editForm.value.transport === 'stdio' ? null : editForm.value.url,
    }

    const res = await updateMCPServer(editForm.value.name, payload)
    if (res.success) {
      ElMessage.success(res.message || 'MCP 服务已更新')
      editDialogVisible.value = false
      await loadServers()
    }
  } catch (error) {
    ElMessage.error(`保存失败: ${error.message}`)
  } finally {
    savingEdit.value = false
  }
}

async function handleConnect(server) {
  try {
    const res = await connectMCPServer(server.name)
    ElMessage.success(res.message || '连接成功')
    await loadServers()
  } catch (error) {
    ElMessage.error(`连接失败: ${error.message}`)
  }
}

async function handleDisconnect(server) {
  try {
    const res = await disconnectMCPServer(server.name)
    ElMessage.success(res.message || '断开成功')
    await loadServers()
  } catch (error) {
    ElMessage.error(`断开失败: ${error.message}`)
  }
}

async function handleTest(server) {
  try {
    const res = await testMCPServer(server.name)
    ElMessage.success(res.message || '测试成功')
    await loadServers()
  } catch (error) {
    ElMessage.error(`测试失败: ${error.message}`)
  }
}

async function showTools(server) {
  try {
    const res = await getMCPServerTools(server.name)
    serverTools.value = res.data?.tools || []
    toolsDialogVisible.value = true
  } catch (error) {
    ElMessage.error(`加载工具失败: ${error.message}`)
  }
}

async function handleDelete(server) {
  try {
    await ElMessageBox.confirm(`确定删除 MCP 服务 “${server.display_name || server.name}” 吗？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
    const res = await deleteMCPServer(server.name)
    ElMessage.success(res.message || '删除成功')
    await loadServers()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      ElMessage.error(`删除失败: ${error.message}`)
    }
  }
}

onMounted(async () => {
  await loadTemplates()
  await loadServers()
  await searchRegistryServers()
})
</script>

<style scoped>
.mcp-container {
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
  margin: 8px 0 0;
  color: #666;
  font-size: 14px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.summary-card {
  border-radius: 14px;
}

.summary-label {
  color: #909399;
  font-size: 12px;
}

.summary-value {
  margin-top: 8px;
  font-size: 28px;
  font-weight: 600;
  color: #303133;
}

.panel-card + .panel-card {
  margin-top: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hint-text {
  margin-top: 6px;
  color: #909399;
  font-size: 12px;
}

.server-title {
  font-weight: 600;
}

.server-subtitle {
  margin-top: 4px;
  color: #909399;
  font-size: 12px;
}

.status-cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.error-inline {
  font-size: 12px;
  line-height: 1.4;
  color: #f56c6c;
  word-break: break-word;
}

.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.registry-toolbar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}

.registry-result {
  padding: 14px;
  border: 1px solid #ebeef5;
  border-radius: 12px;
}

.registry-result + .registry-result {
  margin-top: 12px;
}

.registry-result-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.registry-description {
  margin-top: 10px;
  color: #606266;
  line-height: 1.5;
  font-size: 13px;
}

.registry-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.registry-load-more {
  display: flex;
  justify-content: center;
  margin-top: 16px;
}

@media (max-width: 1200px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 768px) {
  .summary-grid {
    grid-template-columns: 1fr;
  }
}
</style>
