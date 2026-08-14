<template>
  <PageLayout
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    content-padding="var(--spacing-lg)"
    mobile-content-padding="var(--spacing-sm)"
    title="智能体性能监控"
    subtitle="调用量、耗时与成功率"
    mobile-title="性能监控"
  >
    <template #header-actions>
      <p class="page-hint">
        <span>自动刷新 {{ autoRefreshSeconds }}s</span>
        <span v-if="lastUpdatedAt">最近更新 {{ formatRefreshTime(lastUpdatedAt) }}</span>
      </p>
      <CustomSelect
        class="monitor-agent-select"
        :model-value="selectedAgent"
        :options="[{ value: '', label: '全部智能体' }, ...agentList.map(a => ({ value: a, label: a }))]"
        placeholder="全部智能体"
        @update:model-value="selectedAgent = $event; loadMetrics()"
      />
      <Button variant="ghost" size="icon-sm" :disabled="loading" aria-label="刷新" title="刷新" @click="loadMetrics">
        <IconRefresh :size="16" />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="重置指标" title="重置指标" @click="confirmReset">
        <IconTrash :size="16" />
      </Button>
    </template>

    <template #mobile-menu="{ close }">
      <div class="pl-menu-label">智能体筛选</div>
      <button
        v-for="opt in [{ value: '', label: '全部智能体' }, ...agentList.map(a => ({ value: a, label: a }))]"
        :key="opt.value"
        class="pl-menu-item"
        :class="{ 'pl-menu-item--active': selectedAgent === opt.value }"
        @click="selectedAgent = opt.value; loadMetrics(); close()"
      >
        <IconCheck v-if="selectedAgent === opt.value" :size="14" />
        <span :style="selectedAgent !== opt.value ? 'padding-left: 22px' : ''">{{ opt.label }}</span>
      </button>
      <div class="pl-menu-divider"></div>
      <button class="pl-menu-item" :disabled="loading" @click="loadMetrics(); close()">
        <IconRefresh :size="16" />
        刷新
      </button>
      <button class="pl-menu-item pl-menu-item--danger" @click="confirmReset(); close()">
        <IconTrash :size="16" />
        重置指标
      </button>
    </template>

    <EntityListLayout
      v-if="loading || error"
      title="性能监控"
      description="实时查看调用次数、耗时、成功率与工具使用统计。"
      :loading="loading"
      loading-text="加载中..."
      :error="error"
      @retry="loadMetrics"
    />

    <template v-else>
      <div v-if="!selectedAgent && executionOverview" class="execution-overview">
        <KpiCards :items="executionKpis" />

        <div v-if="runningTasks.length > 0 || selectedTaskId" class="detail-card">
          <div class="detail-card__head"><h2>执行平面详情</h2><span>运行中任务与诊断信息</span></div>
          <div class="detail-card__body">
            <div v-if="runningTasks.length > 0" class="sub-section">
              <h4 class="sub-section__title">运行中任务列表</h4>
              <div class="running-task-list">
                <button
                  v-for="task in runningTasks.slice(0, 8)"
                  :key="task.task_id"
                  type="button"
                  class="running-task-item"
                  :class="{ 'is-active': selectedTaskId === task.task_id }"
                  @click="selectTask(task.task_id)"
                >
                  <div class="running-task-main">
                    <Badge variant="outline">{{ task.execution_kind }}</Badge>
                    <span class="running-task-title">{{ task.task || task.task_id }}</span>
                  </div>
                  <div class="running-task-meta">
                    <span>{{ task.session_id || '无会话' }}</span>
                    <span>{{ task.run_id }}</span>
                    <span>{{ task.elapsed_seconds }}s</span>
                  </div>
                </button>
              </div>
            </div>

            <div v-if="selectedTaskId" class="sub-section">
              <div class="detail-inline-head">
                <h4 class="sub-section__title">任务详情</h4>
                <Button variant="ghost" size="sm" @click="clearSelectedTask">关闭</Button>
              </div>

              <div v-if="taskDetailLoading" class="inline-state g-loading-inline"><span class="g-spinner g-spinner--sm"></span>加载任务详情中...</div>
              <div v-else-if="taskDetailError" class="inline-state inline-state--error">{{ taskDetailError }}</div>
              <div v-else-if="selectedTaskStatus" class="task-detail-grid">
                <div class="task-detail-card">
                  <div class="task-detail-title">状态快照</div>
                  <div class="task-detail-row"><span>task_id</span><code>{{ selectedTaskStatus.task_id }}</code></div>
                  <div class="task-detail-row"><span>session_id</span><code>{{ selectedTaskStatus.session_id || '—' }}</code></div>
                  <div class="task-detail-row"><span>run_id</span><code>{{ selectedTaskStatus.run_id || '—' }}</code></div>
                  <div class="task-detail-row"><span>request_id</span><code>{{ selectedTaskStatus.request_id || '—' }}</code></div>
                  <div class="task-detail-row"><span>execution_kind</span><code>{{ selectedTaskStatus.execution_kind }}</code></div>
                  <div class="task-detail-row"><span>status</span><strong>{{ selectedTaskStatus.status }}</strong></div>
                  <div class="task-detail-row"><span>elapsed</span><span>{{ selectedTaskStatus.elapsed_seconds }}s</span></div>
                </div>

                <div v-if="selectedTaskDiagnostics" class="task-detail-card">
                  <div class="task-detail-title">执行诊断</div>
                  <div class="task-detail-row"><span>handle_registered</span><strong>{{ selectedTaskDiagnostics.handle_registered ? '是' : '否' }}</strong></div>
                  <div class="task-detail-row"><span>is_running</span><strong>{{ selectedTaskDiagnostics.is_running ? '是' : '否' }}</strong></div>
                  <div class="task-detail-row"><span>runner.status</span><code>{{ selectedTaskDiagnostics.runner?.status || '—' }}</code></div>
                  <div class="task-detail-row"><span>runner.thread_alive</span><code>{{ selectedTaskDiagnostics.runner?.thread_alive ?? '—' }}</code></div>
                  <div class="task-detail-row"><span>observability</span><code>{{ formatObservability(selectedTaskDiagnostics.observability) }}</code></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <KpiCards v-if="!selectedAgent && systemMetrics" :items="systemKpis" />

      <div class="detail-card">
        <div class="detail-card__head"><h2>智能体详情</h2><span>各智能体调用统计与工具使用分布</span></div>
        <EntityListLayout
          v-if="agentMetrics.length === 0"
          title="智能体详情"
          empty-title="暂无性能数据"
          empty-hint="Agent 运行后这里会显示统计"
        />
        <div v-else class="agents-list">
          <div v-for="agent in agentMetrics" :key="agent.agent_name" class="agent-card">
            <div class="agent-card__head">
              <span class="agent-name">{{ agent.agent_name }}</span>
              <div class="badge-group">
                <Badge variant="success">成功率 {{ formatPercent(agent.success_rate) }}</Badge>
                <Badge variant="secondary">调用 {{ agent.total_calls }} 次</Badge>
              </div>
            </div>

            <div class="agent-metrics">
              <div class="metric-item"><span class="metric-item__label">平均耗时</span><span class="metric-item__value">{{ formatDuration(agent.avg_duration_ms) }}</span></div>
              <div class="metric-item"><span class="metric-item__label">成功 / 失败</span><span class="metric-item__value">{{ agent.success_count ?? 0 }} / {{ agent.failure_count ?? 0 }}</span></div>
              <div v-if="agent.avg_tokens > 0" class="metric-item"><span class="metric-item__label">平均 Token</span><span class="metric-item__value">{{ Math.round(agent.avg_tokens) }}</span></div>
              <div v-if="agent.first_call" class="metric-item"><span class="metric-item__label">首次调用</span><span class="metric-item__value">{{ formatTime(agent.first_call) }}</span></div>
              <div v-if="agent.last_call" class="metric-item"><span class="metric-item__label">最近调用</span><span class="metric-item__value">{{ formatTime(agent.last_call) }}</span></div>
            </div>

            <div v-if="Object.keys(agent.tool_usage || {}).length > 0" class="sub-section">
              <h4 class="sub-section__title">工具使用统计</h4>
              <div class="tool-list">
                <div v-for="(count, tool) in agent.tool_usage" :key="tool" class="tool-item">
                  <span class="tool-name">{{ tool }}</span>
                  <span class="tool-count">{{ count }} 次</span>
                  <div class="tool-bar"><div class="tool-bar__fill" :style="{ width: getToolPercentage(count, agent.tool_usage) + '%' }"></div></div>
                </div>
              </div>
            </div>

            <div v-if="Object.keys(agent.error_distribution || {}).length > 0" class="sub-section">
              <h4 class="sub-section__title">错误分布</h4>
              <div class="error-list">
                <div v-for="(count, errorType) in agent.error_distribution" :key="errorType" class="error-item">
                  <span class="error-type">{{ errorType }}</span>
                  <span class="error-count">{{ count }} 次</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </PageLayout>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed, h } from 'vue';
import PageLayout from '../components/PageLayout.vue';
import IconRefresh from '../components/icons/IconRefresh.vue';
import IconCheck from '../components/icons/IconCheck.vue';
import IconTrash from '../components/icons/IconTrash.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import { Badge } from '../components/ui/badge';
import KpiCards from '../components/admin/KpiCards.vue';
import CustomSelect from '../components/ui/CustomSelect.vue';
import { Button } from '../components/ui/button';
import { useConfirm } from '../composables/useConfirm.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import {
  getExecutionOverview, getMetrics, getRunningTasks,
  getTaskExecutionDiagnostics, getTaskStatus, resetMetrics,
} from '../api/monitoring';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const { confirm } = useConfirm();

const SVG = { xmlns: 'http://www.w3.org/2000/svg', width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
const IconRunning = () => h('svg', SVG, [h('polyline', { points: '16 18 22 12 16 6' }), h('polyline', { points: '8 6 2 12 8 18' })]);
const IconSession = () => h('svg', SVG, [h('path', { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }), h('circle', { cx: 9, cy: 7, r: 4 }), h('path', { d: 'M23 21v-2a4 4 0 0 0-3-3.87' }), h('path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' })]);
const IconAgentExec = () => h('svg', SVG, [h('rect', { x: 2, y: 3, width: 20, height: 14, rx: 2 }), h('line', { x1: 8, y1: 21, x2: 16, y2: 21 }), h('line', { x1: 12, y1: 17, x2: 12, y2: 21 })]);
const IconMcp = () => h('svg', SVG, [h('circle', { cx: 12, cy: 12, r: 3 }), h('path', { d: 'M19.07 4.93a10 10 0 0 1 0 14.14' }), h('path', { d: 'M4.93 4.93a10 10 0 0 0 0 14.14' })]);
const IconAgents = () => h('svg', SVG, [h('path', { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }), h('circle', { cx: 9, cy: 7, r: 4 }), h('path', { d: 'M23 21v-2a4 4 0 0 0-3-3.87' }), h('path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' })]);
const IconCalls = () => h('svg', SVG, [h('polyline', { points: '22 12 18 12 15 21 9 3 6 12 2 12' })]);
const IconDuration = () => h('svg', SVG, [h('circle', { cx: 12, cy: 12, r: 10 }), h('polyline', { points: '12 6 12 12 16 14' })]);
const IconSuccess = () => h('svg', SVG, [h('polyline', { points: '20 6 9 17 4 12' })]);

const loading = ref(false);
const error = ref('');
const selectedAgent = ref('');
const metricsData = ref(null);
const executionOverview = ref(null);
const runningTasks = ref([]);
const selectedTaskId = ref('');
const selectedTaskStatus = ref(null);
const selectedTaskDiagnostics = ref(null);
const taskDetailLoading = ref(false);
const taskDetailError = ref('');
const lastUpdatedAt = ref(null);

const autoRefreshSeconds = 10;
let refreshTimer = null;

const systemMetrics = computed(() => {
  if (!metricsData.value) return null;
  return metricsData.value.system_metrics || metricsData.value;
});
const agentMetrics = computed(() => {
  if (!metricsData.value) return [];
  if (selectedAgent.value) {
    const agent = metricsData.value.agent_metrics || metricsData.value;
    return agent ? [agent] : [];
  }
  const agents = metricsData.value.agents || {};
  return Object.values(agents);
});
const agentList = computed(() => {
  if (!metricsData.value) return [];
  return Object.keys(metricsData.value.agents || {});
});

const executionKpis = computed(() => {
  const ov = executionOverview.value || {};
  return [
    { key: 'running', label: '运行中任务', value: ov.count ?? 0, icon: IconRunning },
    { key: 'sessions', label: '活跃会话', value: ov.sessions?.length ?? 0, icon: IconSession },
    { key: 'agent-stream', label: 'Agent 执行', value: ov.by_execution_kind?.agent_stream ?? 0, icon: IconAgentExec },
    { key: 'mcp', label: 'MCP 调用', value: ov.by_execution_kind?.mcp_tool_call ?? 0, icon: IconMcp },
  ];
});
const systemKpis = computed(() => {
  const sm = systemMetrics.value || {};
  return [
    { key: 'agents', label: '智能体总数', value: sm.total_agents ?? 0, icon: IconAgents },
    { key: 'calls', label: '总调用次数', value: sm.total_calls ?? 0, icon: IconCalls },
    { key: 'duration', label: '平均耗时', value: formatDuration(sm.avg_duration_ms), icon: IconDuration },
    { key: 'success', label: '总体成功率', value: formatPercent(sm.overall_success_rate), icon: IconSuccess },
  ];
});

async function loadMetrics({ silent = false } = {}) {
  if (!silent) {
    loading.value = true;
    error.value = '';
  }
  try {
    const data = await getMetrics(selectedAgent.value || null);
    metricsData.value = data;
    if (!selectedAgent.value) {
      const [overview, running] = await Promise.all([
        getExecutionOverview(true).catch(() => null),
        getRunningTasks().catch(() => ({ items: [] })),
      ]);
      executionOverview.value = overview;
      runningTasks.value = running?.items || [];
      if (selectedTaskId.value) await selectTask(selectedTaskId.value, { silent: true, force: true });
    } else {
      executionOverview.value = null;
      runningTasks.value = [];
      clearSelectedTask();
    }
    lastUpdatedAt.value = new Date();
  } catch (err) {
    error.value = err?.message || '加载指标失败';
  } finally {
    if (!silent) loading.value = false;
  }
}

function clearSelectedTask() {
  selectedTaskId.value = '';
  selectedTaskStatus.value = null;
  selectedTaskDiagnostics.value = null;
  taskDetailLoading.value = false;
  taskDetailError.value = '';
}

const { run: runSelectTask } = useAsyncAction(
  async (taskId, opts = {}) => {
    const { silent = false, force = false } = opts;
    if (!taskId) return;
    if (!force && selectedTaskId.value === taskId) return;
    selectedTaskId.value = taskId;
    if (!silent) {
      selectedTaskStatus.value = null;
      selectedTaskDiagnostics.value = null;
      taskDetailLoading.value = true;
      taskDetailError.value = '';
    }
    const [statusData, diagnosticsData] = await Promise.all([
      getTaskStatus(taskId),
      getTaskExecutionDiagnostics(taskId),
    ]);
    selectedTaskStatus.value = statusData?.task_info || null;
    selectedTaskDiagnostics.value = diagnosticsData?.diagnostics || null;
  },
  {
    errorPrefix: '加载任务详情失败',
    showErrorToast: false,
    onError: (e) => { taskDetailError.value = e?.message || '加载任务详情失败'; },
  },
);
function selectTask(taskId, opts) {
  taskDetailLoading.value = true;
  runSelectTask(taskId, opts).finally(() => { taskDetailLoading.value = false; });
}

async function confirmReset() {
  const target = selectedAgent.value ? `智能体 ${selectedAgent.value} 的` : '所有';
  const ok = await confirm({ message: `确定要重置${target}性能指标吗？`, confirmText: '重置', danger: true });
  if (!ok) return;
  runReset();
}
const { run: runReset } = useAsyncAction(
  async () => { await resetMetrics(selectedAgent.value || null); await loadMetrics(); },
  { successMessage: '性能指标已重置', errorPrefix: '重置指标失败' },
);

function formatDuration(ms) {
  if (!ms) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
function formatPercent(value) {
  if (value == null) return '0%';
  return `${(value * 100).toFixed(1)}%`;
}
function formatTime(timeStr) {
  if (!timeStr) return '-';
  return new Date(timeStr).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function formatRefreshTime(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function getToolPercentage(count, toolUsage) {
  const total = Object.values(toolUsage).reduce((sum, c) => sum + c, 0);
  return total > 0 ? (count / total) * 100 : 0;
}
function formatObservability(value) {
  if (!value) return '—';
  const parts = ['task_id', 'session_id', 'run_id', 'execution_kind', 'request_id']
    .filter((key) => value[key])
    .map((key) => `${key}=${value[key]}`);
  return parts.join(' | ') || '—';
}

function startAutoRefresh() {
  if (refreshTimer) return;
  refreshTimer = window.setInterval(() => { loadMetrics({ silent: true }); }, autoRefreshSeconds * 1000);
}
function stopAutoRefresh() {
  if (refreshTimer) { window.clearInterval(refreshTimer); refreshTimer = null; }
}

onMounted(() => { loadMetrics(); startAutoRefresh(); });
onUnmounted(() => { stopAutoRefresh(); });
</script>

<style scoped>
.execution-overview { display: flex; flex-direction: column; gap: var(--spacing-lg); }

.page-hint { margin: 0; color: var(--color-text-secondary); font-size: 11px; display: flex; align-items: center; gap: 4px; }
.page-hint span { display: inline-flex; align-items: center; min-height: 22px; padding: 0 8px; border-radius: var(--radius-sm); background: var(--color-hover-overlay-md); white-space: nowrap; }
@media (max-width: 1200px) { .page-hint { display: none; } }
.monitor-agent-select { width: clamp(136px, 15vw, 200px); flex: 0 1 200px; min-width: 0; }

.detail-card { border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-bg-elevated); box-shadow: none; overflow: hidden; }
.detail-card__head { display: flex; flex-direction: column; gap: 2px; padding: var(--spacing-md) var(--spacing-lg); border-bottom: 1px solid var(--color-border); background: var(--color-bg-elevated); }
.detail-card__head h2 { margin: 0; font-size: var(--font-size-lg); font-weight: 600; color: var(--color-text-primary); }
.detail-card__head span { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
.detail-card__body { padding: var(--spacing-md) var(--spacing-lg); }

.agents-list { display: flex; flex-direction: column; }
.agent-card { padding: var(--spacing-md); border-bottom: 1px solid var(--color-border); transition: background 0.2s; }
.agent-card:last-child { border-bottom: none; }
.agent-card:hover { background: var(--color-hover-overlay-md); }
.agent-card__head { display: flex; justify-content: space-between; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-md); flex-wrap: wrap; }
.agent-name { font-size: var(--font-size-base); font-weight: 600; color: var(--color-text-primary); font-family: var(--font-mono); }

.badge-group { display: flex; gap: var(--spacing-xs); flex-wrap: wrap; }

.agent-metrics { display: flex; flex-wrap: wrap; gap: 0; margin-bottom: var(--spacing-md); border-radius: var(--radius-md); overflow: hidden; background: var(--color-bg-elevated); }
.metric-item { flex: 1 1 160px; display: flex; flex-direction: column; gap: 2px; padding: 10px 14px; border-right: 1px solid var(--color-border); }
.metric-item:last-child { border-right: none; }
.metric-item__label { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
.metric-item__value { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text-primary); }

.sub-section { margin-top: var(--spacing-md); }
.sub-section__title { margin: 0 0 var(--spacing-sm); font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text-secondary); text-transform: uppercase; letter-spacing: 0.06em; }

.running-task-list { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.running-task-item { display: flex; justify-content: space-between; gap: var(--spacing-md); padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-hover-overlay); width: 100%; text-align: left; cursor: pointer; transition: border-color 0.2s, background 0.2s; }
.running-task-item:hover, .running-task-item.is-active { border-color: var(--color-accent-border); background: var(--color-active-bg); }
.running-task-main { display: flex; align-items: center; gap: var(--spacing-sm); min-width: 0; }
.running-task-title { color: var(--color-text-primary); font-weight: 600; word-break: break-all; }
.running-task-meta { display: flex; align-items: center; gap: var(--spacing-sm); color: var(--color-text-secondary); font-size: var(--font-size-xs); flex-wrap: wrap; justify-content: flex-end; }

.detail-inline-head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); }
.btn-inline { border: none; background: transparent; color: var(--color-brand-accent-light); cursor: pointer; font-size: var(--font-size-xs); font-weight: 600; }
.inline-state { padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-md); color: var(--color-text-secondary); }
.inline-state--error { border-color: color-mix(in srgb, var(--color-error) 35%, transparent); color: var(--color-error); }

.task-detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }
.task-detail-card { padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-hover-overlay); }
.task-detail-title { margin-bottom: 10px; font-size: var(--font-size-sm); font-weight: 700; color: var(--color-text-primary); }
.task-detail-row { display: flex; justify-content: space-between; gap: var(--spacing-sm); padding: 6px 0; border-bottom: 1px solid rgba(var(--color-border-rgb), 0.3); font-size: var(--font-size-xs); }
.task-detail-row:last-child { border-bottom: none; }
.task-detail-row span:first-child { color: var(--color-text-secondary); }
.task-detail-row code { color: var(--color-text-primary); word-break: break-all; }

.tool-list { display: flex; flex-direction: column; gap: 6px; }
.tool-item { display: grid; grid-template-columns: 1fr auto; grid-template-rows: auto auto; gap: 4px 8px; align-items: center; }
.tool-name { font-size: var(--font-size-xs); color: var(--color-text-primary); font-family: var(--font-mono); grid-column: 1; grid-row: 1; }
.tool-count { font-size: var(--font-size-xs); color: var(--color-text-secondary); grid-column: 2; grid-row: 1; white-space: nowrap; }
.tool-bar { grid-column: 1 / -1; grid-row: 2; height: 3px; background: var(--color-bg-tertiary); border-radius: var(--radius-full); overflow: hidden; }
.tool-bar__fill { height: 100%; background: var(--color-brand-accent-light); border-radius: var(--radius-full); transition: width 0.4s ease; }

.error-list { display: flex; flex-direction: column; gap: 4px; }
.error-item { display: flex; justify-content: space-between; padding: 6px 10px; background: var(--color-error-bg); border-left: 2px solid var(--color-error); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; font-size: var(--font-size-xs); }
.error-type { color: var(--color-error); font-weight: 500; }
.error-count { color: var(--color-text-secondary); }

@media (max-width: 640px) {
  .metric-item { border-right: none; border-bottom: 1px solid var(--color-border); }
  .metric-item:last-child { border-bottom: none; }
  .task-detail-grid { grid-template-columns: 1fr; }
  .running-task-item { flex-direction: column; align-items: flex-start; }
  .running-task-meta { justify-content: flex-start; }
}
</style>
