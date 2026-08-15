<template>
  <PageLayout
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    mobile-content-padding="var(--spacing-sm)"
    title="MCP 服务管理"
    subtitle="MCP 工具服务接入与测试"
    mobile-title="MCP 服务管理"
  >
    <template #header-actions>
      <Button variant="ghost" size="icon-sm" :disabled="loadingServers" :aria-label="loadingServers ? '刷新中' : '全局刷新'" :title="loadingServers ? '刷新中' : '全局刷新'" @click="refreshAll">
        <IconRefresh :size="16" />
      </Button>
    </template>

    <template #mobile-menu="{ close }">
      <button class="pl-menu-item" :disabled="loadingServers" @click="refreshAll(); close()">
        <IconRefresh :size="16" />
        {{ loadingServers ? '刷新中...' : '全局刷新' }}
      </button>
    </template>

    <KpiCards :items="kpiItems" />

    <EntityListLayout
      title="已安装服务"
      description="管理连接状态、查看工具、修改运行参数。"
      :loading="loadingServers"
      loading-text="正在加载 MCP 服务..."
      :empty="!servers.length"
      empty-title="暂无 MCP 服务"
      empty-hint="点击右上「添加服务」从 Registry 搜索或手动配置。"
      @retry="runLoadServers"
    >
      <template #actions>
        <Button variant="default" @click="openAddService">
          <IconPlus :size="14" />
          <span>添加服务</span>
        </Button>
        <Button variant="secondary" :disabled="loadingServers" @click="runLoadServers">
          <IconRefresh :size="14" />
          <span>刷新</span>
        </Button>
      </template>
      <template #empty-icon>
        <Monitor :size="40" :stroke-width="1.5" />
      </template>

      <div class="server-grid adm-entity-list">
        <article v-for="server in servers" :key="server.name" class="server-card adm-entity-row">
          <div class="server-card__main">
            <div class="server-card-head">
              <div class="server-card-icon" :class="`server-icon--${server.transport || 'stdio'}`">
                <Terminal v-if="(server.transport || 'stdio') === 'stdio'" :size="18" />
                <Globe v-else :size="18" />
              </div>
              <div class="server-card-info">
                <div class="server-card-name">{{ server.display_name || server.name }}</div>
                <div class="server-card-sub">
                  <code class="server-card-id">{{ server.name }}</code>
                  <code class="server-card-conn">{{ server.transport === 'stdio' ? (server.command ? `${server.command} ${formatArgs(server.args)}` : '无命令') : (server.url || '无地址') }}</code>
                </div>
              </div>
            </div>
            <div class="server-card-badges">
              <StatusDot :tone="statusDotTone(server.status)" :pulse="server.status === 'connecting'" :label="server.status || 'unknown'" />
              <Badge :variant="statusBadgeVariant(server.status)">{{ server.status || 'unknown' }}</Badge>
              <Badge v-if="server.trusted === false" variant="warning" title="未受信任:annotations 不驱动并发,工具保守串行">未信任</Badge>
            </div>
          </div>

          <div class="server-meta-row">
            <div class="meta-chip"><span class="meta-chip-label">传输</span><span class="meta-chip-value meta-chip-value--mono">{{ server.transport || 'stdio' }}</span></div>
            <div class="meta-chip"><span class="meta-chip-label">工具</span><span class="meta-chip-value">{{ server.tool_count || 0 }}</span></div>
            <div v-if="server.capability_faces?.resources" class="meta-chip"><span class="meta-chip-label">资源</span><span class="meta-chip-value">{{ server.resource_count || 0 }}</span></div>
            <div v-if="server.capability_faces?.prompts" class="meta-chip"><span class="meta-chip-label">提示词</span><span class="meta-chip-value">{{ server.prompt_count || 0 }}</span></div>
            <div class="meta-chip"><span class="meta-chip-label">风险</span><span class="meta-chip-value" :class="`risk--${server.risk_level || 'medium'}`">{{ server.risk_level || 'medium' }}</span></div>
            <div class="meta-chip"><span class="meta-chip-label">状态</span><span class="meta-chip-value" :class="server.enabled ? 'text-success' : 'text-muted'">{{ server.enabled ? '已启用' : '已禁用' }}</span></div>
          </div>

          <div v-if="server.error_message" class="error-banner">
            <IconInfo :size="14" />
            {{ server.error_message }}
          </div>

          <div class="server-actions">
            <Button variant="action-success" size="action" :disabled="!server.enabled || server.status === 'connected'" @click="handleConnect(server)" title="连接">
              <Wifi />连接
            </Button>
            <Button variant="action-warning" size="action" :disabled="server.status !== 'connected'" @click="handleDisconnect(server)" title="断开">
              <WifiOff />断开
            </Button>
            <Button variant="action-neutral" size="action" @click="handleTest(server)" title="测试连接">
              <Clock />测试
            </Button>
            <Button variant="action-neutral" size="action" @click="showTools(server)" title="查看工具">
              <Wrench />工具 <span v-if="server.tool_count" class="adm-action-badge">{{ server.tool_count }}</span>
            </Button>
            <Button v-if="server.capability_faces?.resources" variant="action-neutral" size="action" @click="showResources(server)" title="查看资源">
              <Database />资源 <span v-if="server.resource_count" class="adm-action-badge">{{ server.resource_count }}</span>
            </Button>
            <Button v-if="server.capability_faces?.prompts" variant="action-neutral" size="action" @click="showPrompts(server)" title="查看提示词">
              <MessageSquare />提示词 <span v-if="server.prompt_count" class="adm-action-badge">{{ server.prompt_count }}</span>
            </Button>
            <Button variant="action-neutral" size="action" @click="openEditDialog(server)" title="编辑配置">
              <IconEdit :size="14" />编辑
            </Button>
            <Button variant="action-danger" size="action" @click="handleDelete(server)" title="删除">
              <IconTrash :size="14" />删除
            </Button>
          </div>
        </article>
      </div>
    </EntityListLayout>

    <McpAddServicePanel
      v-if="addServiceVisible"
      v-model:add-mode="addMode"
      :install-form="installForm"
      :transport-options="transportOptions"
      :risk-options="riskOptions"
      :installing="installing"
      :registry-search="registrySearch"
      :loading-registry-results="loadingRegistryResults"
      :registry-results="registryResults"
      :installing-registry="installingRegistry"
      :registry-next-cursor="registryNextCursor"
      :loading-more-registry="loadingMoreRegistry"
      :reset-install-form="resetInstallForm"
      :submit-manual-install="submitManualInstall"
      :search-registry-servers="searchRegistryServers"
      :load-more-registry-servers="loadMoreRegistryServers"
      :handle-registry-install="handleRegistryInstall"
      :open-registry-install-dialog="openRegistryInstallDialog"
      :quick-install-button-text="quickInstallButtonText"
      :first-unsupported-reason="firstUnsupportedReason"
      :open-external-link="openExternalLink"
      @close="addServiceVisible = false"
    />

    <McpRegistryInstallDialog
      :open="registryInstallDialogVisible"
      :server="selectedRegistryServer"
      :form="registryInstallForm"
      :selected-option="selectedRegistryOption"
      :fields="selectedRegistryFields"
      :risk-options="riskOptions"
      :installing="installingRegistry"
      @close="closeRegistryInstallDialog"
      @submit="submitRegistryInstall()"
      @option-change="handleRegistryOptionChange"
    />

    <McpServerEditDialog
      :open="editDialogVisible"
      :form="editForm"
      :transport-options="transportOptions"
      :risk-options="riskOptions"
      :saving="savingEdit"
      @close="closeEditDialog"
      @submit="saveEdit"
    />

    <McpToolsDialog
      :open="toolsDialogVisible"
      :server-name="activeToolsServerName"
      :tools="serverTools"
      :risk-options="riskOptions"
      :get-tool-metrics="getToolMetrics"
      :tool-parameters="toolParameters"
      @close="closeToolsDialog"
      @update-risk="updateToolRisk"
    />

    <McpResourcesDialog
      :open="resourcesDialogVisible"
      :server="activeResourcesServer"
      :resources="serverResources"
      @close="closeResourcesDialog"
      @toggle-resource="toggleResource"
    />

    <McpPromptsDialog
      :open="promptsDialogVisible"
      :server="activePromptsServer"
      :prompts="serverPrompts"
      @close="closePromptsDialog"
    />
  </PageLayout>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue';
import { CheckCircle2, Clock, Database, Globe, MessageSquare, Monitor, Terminal, Wifi, WifiOff, Wrench } from 'lucide-vue-next';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import KpiCards from '../components/admin/KpiCards.vue';
import StatusDot from '../components/admin/StatusDot.vue';
import McpAddServicePanel from '../components/mcp/McpAddServicePanel.vue';
import McpPromptsDialog from '../components/mcp/McpPromptsDialog.vue';
import McpRegistryInstallDialog from '../components/mcp/McpRegistryInstallDialog.vue';
import McpResourcesDialog from '../components/mcp/McpResourcesDialog.vue';
import McpServerEditDialog from '../components/mcp/McpServerEditDialog.vue';
import McpToolsDialog from '../components/mcp/McpToolsDialog.vue';
import '../components/mcp/mcp-dialogs.css';
import PageLayout from '../components/PageLayout.vue';
import IconRefresh from '../components/icons/IconRefresh.vue';
import IconPlus from '../components/icons/IconPlus.vue';
import IconEdit from '../components/icons/IconEdit.vue';
import IconTrash from '../components/icons/IconTrash.vue';
import IconInfo from '../components/icons/IconInfo.vue';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { useToast } from '../composables/useToast.js';
import { useConfirm } from '../composables/useConfirm.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import {
  addMCPServer, connectMCPServer, deleteMCPServer, disconnectMCPServer,
  getMCPServerTools, getMCPServerMetrics, installMCPRegistryServer, listMCPRegistryServers,
  listMCPServers, listMCPServerResources, listMCPServerPrompts,
  readMCPServerResource, testMCPServer, updateMCPServer,
} from '../api/mcpService';
import { useMcpStore } from '../stores/mcp.js';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const toast = useToast();
const { confirm } = useConfirm();

const addServiceVisible = ref(false);
const addMode = ref('manual');

const servers = ref([]);
const registryResults = ref([]);
const registryNextCursor = ref('');
const serverTools = ref([]);
const activeToolsServerName = ref('');
const activeToolsServer = ref(null);
const serverMetrics = ref({});
const serverResources = ref([]);
const resourcesDialogVisible = ref(false);
const activeResourcesServer = ref(null);
const serverPrompts = ref([]);
const promptsDialogVisible = ref(false);
const activePromptsServer = ref(null);
const selectedRegistryServer = ref(null);
const registryInstallDialogVisible = ref(false);
const editDialogVisible = ref(false);
const toolsDialogVisible = ref(false);
const editForm = ref(null);

const riskOptions = [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }];
const transportOptions = [
  { value: 'stdio', label: 'stdio（本地进程）' },
  { value: 'sse', label: 'SSE（Server-Sent Events）' },
  { value: 'streamable_http', label: 'Streamable HTTP' },
];

const installForm = reactive({ server_name: '', display_name: '', transport: 'stdio', command: '', argsJson: '[]', envJson: '{}', url: '', headersJson: '{}', enabled: true, auto_connect: true, timeout: 30, risk_level: 'medium', toolRiskOverridesJson: '{}', trusted: true });
const registrySearch = reactive({ query: '', latest_only: true, limit: 6 });
const registryInstallForm = reactive({ option_id: '', server_name: '', display_name: '', enabled: true, auto_connect: true, timeout: 30, risk_level: 'medium', input_values: {} });

const summary = computed(() => ({
  total: servers.value.length,
  connected: servers.value.filter((s) => s.status === 'connected').length,
  enabled: servers.value.filter((s) => s.enabled).length,
  tools: servers.value.reduce((sum, s) => sum + (s.tool_count || 0), 0),
}));
const kpiItems = computed(() => [
  { key: 'total', label: '服务总数', value: summary.value.total, icon: Monitor },
  { key: 'connected', label: '已连接', value: summary.value.connected, icon: Wifi },
  { key: 'enabled', label: '已启用', value: summary.value.enabled, icon: CheckCircle2 },
  { key: 'tools', label: '可用工具', value: summary.value.tools, icon: Wrench },
]);
const selectedRegistryOption = computed(() => selectedRegistryServer.value?.install_options?.find((o) => o.id === registryInstallForm.option_id) || null);
const selectedRegistryFields = computed(() => selectedRegistryOption.value?.form_fields || []);

function openExternalLink(url) { window.open(url, '_blank', 'noopener,noreferrer'); }
function statusBadgeVariant(status) {
  if (status === 'connected') return 'success';
  if (status === 'connecting') return 'warning';
  if (status === 'error') return 'destructive';
  return 'secondary';
}
function statusDotTone(status) {
  if (status === 'connected') return 'success';
  if (status === 'connecting') return 'warning';
  if (status === 'error') return 'error';
  return 'muted';
}
function formatArgs(args) { return Array.isArray(args) && args.length ? args.join(' ') : ''; }
function resetInstallForm() {
  Object.assign(installForm, { server_name: '', display_name: '', transport: 'stdio', command: '', argsJson: '[]', envJson: '{}', url: '', headersJson: '{}', enabled: true, auto_connect: true, timeout: 30, risk_level: 'medium', toolRiskOverridesJson: '{}', trusted: true });
}
function defaultFieldValue(field) {
  if (field.default_value !== null && field.default_value !== undefined) return field.default_value;
  if (field.format === 'select') return field.options?.[0]?.value ?? '';
  if (field.format === 'boolean') return false;
  return '';
}
function initializeRegistryInputValues(option) {
  const values = {};
  (option?.form_fields || []).forEach((f) => { values[f.key] = defaultFieldValue(f); });
  registryInstallForm.input_values = values;
}
function getPreferredInstallOption(server) {
  return server?.install_options?.find((o) => o.id === server.preferred_option_id) || server?.install_options?.find((o) => o.supported) || server?.install_options?.[0] || null;
}
function countSupportedInstallOptions(server) { return (server?.install_options || []).filter((o) => o.supported).length; }
function canQuickInstall(server) {
  const option = getPreferredInstallOption(server);
  if (!option?.supported) return false;
  if (countSupportedInstallOptions(server) !== 1) return false;
  return !(option.form_fields || []).some((f) => f.required && (f.default_value === null || f.default_value === undefined || f.default_value === ''));
}
function quickInstallButtonText(server) { return canQuickInstall(server) ? '一键安装' : '安装'; }
function firstUnsupportedReason(server) { return server?.install_options?.find((o) => !o.supported)?.unsupported_reason || ''; }
function applyRegistryInstallDefaults(server, option) {
  registryInstallForm.option_id = option?.id || '';
  registryInstallForm.server_name = option?.default_server_name || server?.default_server_name || '';
  registryInstallForm.display_name = option?.default_display_name || server?.default_display_name || server?.display_name || '';
  registryInstallForm.enabled = true;
  registryInstallForm.auto_connect = true;
  registryInstallForm.timeout = option?.default_timeout || 30;
  registryInstallForm.risk_level = option?.default_risk_level || 'medium';
  initializeRegistryInputValues(option);
}
function openRegistryInstallDialog(server) { selectedRegistryServer.value = server; applyRegistryInstallDefaults(server, getPreferredInstallOption(server)); registryInstallDialogVisible.value = true; }
function closeRegistryInstallDialog() { registryInstallDialogVisible.value = false; }
function handleRegistryOptionChange(optionId) {
  const option = selectedRegistryServer.value?.install_options?.find((o) => o.id === optionId);
  if (!option) return;
  registryInstallForm.timeout = option.default_timeout || registryInstallForm.timeout;
  registryInstallForm.risk_level = option.default_risk_level || registryInstallForm.risk_level;
  initializeRegistryInputValues(option);
}
function openEditDialog(server) {
  editForm.value = {
    name: server.name,
    display_name: server.display_name || '',
    transport: server.transport || 'stdio',
    command: server.command || '',
    argsJson: JSON.stringify(server.args || [], null, 2),
    envJson: JSON.stringify(server.env || {}, null, 2),
    headersJson: JSON.stringify(server.headers || {}, null, 2),
    url: server.url || '',
    enabled: !!server.enabled,
    auto_connect: !!server.auto_connect,
    timeout: server.timeout || 30,
    risk_level: server.risk_level || 'medium',
    toolRiskOverridesJson: JSON.stringify(server.tool_risk_overrides || {}, null, 2),
    trusted: server.trusted ?? true,
  };
  editDialogVisible.value = true;
}
function closeEditDialog() { editDialogVisible.value = false; editForm.value = null; }
function closeToolsDialog() { toolsDialogVisible.value = false; }
function openAddService() {
  addServiceVisible.value = true;
  nextTick(() => {
    document.querySelector('.add-service-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

const { run: runLoadServers, loading: loadingServers } = useAsyncAction(
  async () => {
    const res = await listMCPServers();
    servers.value = res.data || [];
    useMcpStore().reloadPrompts();
  },
  { errorPrefix: '加载服务失败' },
);
function refreshAll() { runLoadServers(); }

const { run: runSearch, loading: loadingRegistryResults } = useAsyncAction(
  async (opts = {}) => {
    const append = opts.append === true;
    if (append && !registryNextCursor.value) return;
    const res = await listMCPRegistryServers({ search: registrySearch.query, limit: registrySearch.limit, cursor: append ? registryNextCursor.value : '', latest_only: registrySearch.latest_only });
    const items = res.data?.items || [];
    registryResults.value = append ? [...registryResults.value, ...items] : items;
    registryNextCursor.value = res.data?.next_cursor || '';
  },
  { errorPrefix: '搜索 Registry 失败', showErrorToast: false },
);
function searchRegistryServers() { runSearch({ append: false }); }
const { run: runLoadMore, loading: loadingMoreRegistry } = useAsyncAction(
  () => runSearch({ append: true }),
  { showErrorToast: false },
);
function loadMoreRegistryServers() { runLoadMore(); }

const { run: runInstall, loading: installing } = useAsyncAction(
  async (payload) => {
    await addMCPServer(payload);
    resetInstallForm();
    await runLoadServers();
    addServiceVisible.value = false;
  },
  { successMessage: (r) => r?.message || '安装成功', errorPrefix: '安装失败' },
);
function submitManualInstall() {
  if (!installForm.server_name) return toast.warning('请填写服务名称');
  const isStdio = installForm.transport === 'stdio';
  if (isStdio && !installForm.command) return toast.warning('请填写启动命令');
  if (!isStdio && !installForm.url) return toast.warning('请填写 URL');
  let parsedArgs, parsedEnv, parsedHeaders, parsedToolRiskOverrides;
  try {
    if (isStdio) { parsedArgs = JSON.parse(installForm.argsJson || '[]'); parsedEnv = JSON.parse(installForm.envJson || '{}'); }
    else { parsedHeaders = JSON.parse(installForm.headersJson || '{}'); }
    parsedToolRiskOverrides = JSON.parse(installForm.toolRiskOverridesJson || '{}');
  } catch (e) { return toast.warning('JSON 格式错误'); }
  const payload = {
    name: installForm.server_name, display_name: installForm.display_name || installForm.server_name,
    transport: installForm.transport, enabled: installForm.enabled, auto_connect: installForm.auto_connect,
    timeout: installForm.timeout, risk_level: installForm.risk_level, tool_risk_overrides: parsedToolRiskOverrides, trusted: installForm.trusted,
    ...(isStdio ? { command: installForm.command, args: parsedArgs, env: parsedEnv } : { url: installForm.url, headers: parsedHeaders }),
  };
  runInstall(payload);
}

const { run: runRegistryInstall, loading: installingRegistry } = useAsyncAction(
  async (payload) => {
    await installMCPRegistryServer(payload);
    closeRegistryInstallDialog();
    await runLoadServers();
    addServiceVisible.value = false;
  },
  { successMessage: (r) => r?.message || '安装成功', errorPrefix: 'Registry 安装失败' },
);
function submitRegistryInstall(customPayload = null) {
  const option = selectedRegistryOption.value || customPayload?.install_option;
  if (!option) return toast.warning('请选择一个可用的安装方式');
  if (!option.supported) return toast.warning(option.unsupported_reason || '当前安装方式暂不支持');
  const payload = customPayload || {
    install_option: option, server_name: registryInstallForm.server_name, display_name: registryInstallForm.display_name,
    enabled: registryInstallForm.enabled, auto_connect: registryInstallForm.auto_connect, timeout: registryInstallForm.timeout,
    risk_level: registryInstallForm.risk_level, input_values: registryInstallForm.input_values,
  };
  const missing = (option.form_fields || []).find((f) => f.required && (payload.input_values?.[f.key] === '' || payload.input_values?.[f.key] == null));
  if (missing) return toast.warning(`请填写 ${missing.label}`);
  runRegistryInstall(payload);
}
function handleRegistryInstall(server) {
  const option = getPreferredInstallOption(server);
  if (!option?.supported) return toast.warning(firstUnsupportedReason(server) || '当前没有可用安装方式');
  if (!canQuickInstall(server)) { openRegistryInstallDialog(server); return; }
  submitRegistryInstall({
    install_option: option,
    server_name: option.default_server_name || server.default_server_name,
    display_name: option.default_display_name || server.default_display_name,
    enabled: true, auto_connect: true, timeout: option.default_timeout || 30, risk_level: option.default_risk_level || 'medium',
    input_values: Object.fromEntries((option.form_fields || []).map((f) => [f.key, defaultFieldValue(f)])),
  });
}

const { run: runSaveEdit, loading: savingEdit } = useAsyncAction(
  async () => {
    if (!editForm.value) return;
    let parsedArgs = [], parsedEnv = {}, parsedHeaders = {};
    let parsedToolRiskOverrides = {};
    if (editForm.value.transport === 'stdio') { parsedArgs = JSON.parse(editForm.value.argsJson || '[]'); parsedEnv = JSON.parse(editForm.value.envJson || '{}'); }
    else { parsedHeaders = JSON.parse(editForm.value.headersJson || '{}'); }
    parsedToolRiskOverrides = JSON.parse(editForm.value.toolRiskOverridesJson || '{}');
    const isStdio = editForm.value.transport === 'stdio';
    const res = await updateMCPServer(editForm.value.name, {
      display_name: editForm.value.display_name, transport: editForm.value.transport,
      enabled: editForm.value.enabled, auto_connect: editForm.value.auto_connect, timeout: editForm.value.timeout, risk_level: editForm.value.risk_level, tool_risk_overrides: parsedToolRiskOverrides, trusted: editForm.value.trusted,
      command: isStdio ? editForm.value.command : null, args: isStdio ? parsedArgs : [], env: isStdio ? parsedEnv : {},
      headers: isStdio ? {} : parsedHeaders, url: isStdio ? null : editForm.value.url,
    });
    closeEditDialog();
    await runLoadServers();
    return res;
  },
  { successMessage: (r) => r?.message || '保存成功', errorPrefix: '保存失败' },
);
function saveEdit() { runSaveEdit(); }

const { run: runConnect } = useAsyncAction(
  async (server) => { const res = await connectMCPServer(server.name); await runLoadServers(); return res; },
  { successMessage: (r) => r?.message || '连接成功', errorPrefix: '连接失败' },
);
function handleConnect(server) { runConnect(server); }
const { run: runDisconnect } = useAsyncAction(
  async (server) => { const res = await disconnectMCPServer(server.name); await runLoadServers(); return res; },
  { successMessage: (r) => r?.message || '断开成功', errorPrefix: '断开失败' },
);
function handleDisconnect(server) { runDisconnect(server); }
const { run: runTest } = useAsyncAction(
  async (server) => { const res = await testMCPServer(server.name); await runLoadServers(); return res; },
  { successMessage: (r) => r?.message || '测试成功', errorPrefix: '测试失败' },
);
function handleTest(server) { runTest(server); }

const { run: runShowTools } = useAsyncAction(
  async (server) => {
    const [toolsRes, metricsRes] = await Promise.all([
      getMCPServerTools(server.name),
      getMCPServerMetrics(server.name).catch(() => null),
    ]);
    serverTools.value = toolsRes.data?.tools || [];
    const metricsMap = {};
    for (const m of (metricsRes?.data?.tools || [])) {
      metricsMap[m.tool_name] = m;
    }
    serverMetrics.value = metricsMap;
    activeToolsServer.value = server;
    activeToolsServerName.value = server.display_name || server.name;
    toolsDialogVisible.value = true;
  },
  { errorPrefix: '加载工具失败' },
);
function showTools(server) { runShowTools(server); }

function toolParameters(tool) {
  const params = tool?.function?.parameters;
  if (!params || typeof params !== 'object') return [];
  const props = params.properties || {};
  const required = new Set(params.required || []);
  return Object.entries(props).map(([name, schema]) => ({
    name,
    type: schema?.type || (schema?.$ref ? 'ref' : 'any'),
    description: schema?.description || '',
    required: required.has(name),
  }));
}

function getToolMetrics(tool) {
  const name = tool?.function?.original_tool_name || tool?.function?.name;
  return name ? serverMetrics.value[name] : null;
}

async function updateToolRisk(tool, newRisk) {
  const server = activeToolsServer.value;
  const toolName = tool?.function?.original_tool_name || tool?.function?.name;
  if (!server || !toolName) return;
  const overrides = { ...(server.tool_risk_overrides || {}) };
  overrides[toolName] = newRisk;
  // updateMCPServer 是全量更新(后端 {...existing, ...payload}),须传完整 payload 保留 server 现状。
  const isStdio = (server.transport || 'stdio') === 'stdio';
  const payload = {
    display_name: server.display_name || server.name,
    transport: server.transport || 'stdio',
    enabled: server.enabled,
    auto_connect: server.auto_connect,
    timeout: server.timeout || 30,
    risk_level: server.risk_level || 'medium',
    tool_risk_overrides: overrides,
    trusted: server.trusted ?? true,
    ...(isStdio ? { command: server.command || '', args: server.args || [], env: server.env || {} } : { url: server.url || '', headers: server.headers || {} }),
  };
  try {
    await updateMCPServer(server.name, payload);
    server.tool_risk_overrides = overrides;
    if (tool.function) tool.function.risk_level = newRisk;
    toast.success(`${toolName} 风险已设为 ${newRisk}`);
  } catch { /* useAsyncAction 已提示 */ }
}
async function showResources(server) {
  try {
    const res = await listMCPServerResources(server.name);
    serverResources.value = (res.data?.resources || []).map((r) => ({ ...r, expanded: false, content: null, loading: false }));
    activeResourcesServer.value = server;
    resourcesDialogVisible.value = true;
  } catch { /* ignore */ }
}
function closeResourcesDialog() { resourcesDialogVisible.value = false; }
async function toggleResource(resource) {
  if (resource.content !== null) { resource.expanded = !resource.expanded; return; }
  resource.loading = true;
  try {
    const res = await readMCPServerResource(activeResourcesServer.value.name, resource.uri);
    resource.content = res.data?.contents || [];
    resource.expanded = true;
  } finally { resource.loading = false; }
}
async function showPrompts(server) {
  try {
    const res = await listMCPServerPrompts(server.name);
    serverPrompts.value = res.data?.prompts || [];
    activePromptsServer.value = server;
    promptsDialogVisible.value = true;
  } catch { /* ignore */ }
}
function closePromptsDialog() { promptsDialogVisible.value = false; }

const { run: runDelete } = useAsyncAction(
  async (server) => { const res = await deleteMCPServer(server.name); await runLoadServers(); return res; },
  { successMessage: (r) => r?.message || '删除成功', errorPrefix: '删除失败' },
);
async function handleDelete(server) {
  const ok = await confirm({ message: `确定删除 MCP 服务“${server.display_name || server.name}”吗？`, confirmText: '删除', danger: true });
  if (!ok) return;
  runDelete(server);
}

onMounted(() => {
  runLoadServers();
  runSearch({ append: false });
});
</script>

<style scoped>
/* 页面专属：服务列表卡片。添加服务面板与各弹窗样式见 components/mcp/mcp-dialogs.css */
.server-grid { display: flex; flex-direction: column; gap: 0; }
.server-card { display: flex; flex-direction: column; gap: var(--spacing-xs); padding: var(--spacing-sm) var(--spacing-md); }
.server-card__main { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); }
.server-card-head { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
.server-card-icon { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--radius-sm); flex-shrink: 0; border: 1px solid var(--color-border); background: transparent; color: var(--color-text-secondary); }
.server-card-icon svg { width: 14px; height: 14px; }
.server-card-info { flex: 1; min-width: 0; }
.server-card-name { font-weight: 600; font-size: var(--font-size-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.server-card-sub { display: flex; align-items: baseline; gap: var(--spacing-sm); margin-top: 2px; min-width: 0; }
.server-card-id { color: var(--color-text-muted); font-size: var(--font-size-xs); font-family: var(--font-mono); flex-shrink: 0; }
.server-card-conn { color: var(--color-text-muted); font-size: var(--font-size-xs); font-family: var(--font-mono); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.server-card-badges { display: flex; align-items: center; gap: var(--spacing-xs); flex-shrink: 0; }

.server-meta-row { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); min-width: 0; }
.meta-chip { display: inline-flex; align-items: center; gap: var(--spacing-xs); padding: 4px 10px; border-radius: var(--radius-sm); background: var(--color-hover-overlay-md); color: var(--color-text-secondary); font-size: var(--font-size-xs); font-weight: 600; line-height: 1.2; }
.meta-chip-label { color: var(--color-text-muted); }
.meta-chip-value { color: var(--color-text-primary); font-weight: 500; }
.meta-chip-value--mono { font-family: var(--font-mono); }
.risk--low { color: var(--color-success); }
.risk--medium { color: var(--color-warning); }
.risk--high { color: var(--color-error); }
.text-success { color: var(--color-success); }
.text-muted { color: var(--color-text-muted); }

.server-connection-info { background: var(--color-bg-secondary); border-radius: var(--radius-sm); padding: 7px 10px; min-width: 0; }
.connection-code { font-family: var(--font-mono); font-size: var(--font-size-xs); color: var(--color-text-secondary); word-break: break-all; display: block; }

.error-banner { display: flex; align-items: flex-start; gap: var(--spacing-xs); padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--radius-md); background: var(--color-error-bg); color: var(--color-error); font-size: var(--font-size-xs); }
.server-actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; padding-top: var(--spacing-sm); border-top: 1px solid var(--color-border); }

@media (max-width: 720px) {
  .section-toolbar { flex-direction: column; align-items: stretch; }
}
</style>
