<template>
  <PageLayout
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    title="管理中心"
    subtitle="资源存量与运行状态"
    mobile-title="管理中心"
    mobile-content-padding="var(--spacing-lg) var(--spacing-md)"
  >
    <template #header-actions>
      <CustomSelect
        class="admin-range-select"
        :model-value="String(days)"
        :options="dayOptions"
        aria-label="数据分析时间范围"
        @update:model-value="onDaysChange"
      />
      <Button as-child variant="ghost" size="icon-sm" class="admin-header-link" aria-label="返回工作台" title="返回工作台">
        <RouterLink :to="chatReturnPath"><IconChevronLeft :size="16" /></RouterLink>
      </Button>
    </template>

    <KpiCards :items="kpiItems" />

    <div class="admin-overview">
      <Card>
        <CardHeader>
          <CardTitle>系统状态</CardTitle>
          <CardDescription>守护进程与执行平面实时状态（从左侧导航进入各模块管理）</CardDescription>
        </CardHeader>
        <CardContent>
          <div class="status-grid">
          <div class="status-item">
            <span class="status-item__label">守护进程</span>
            <span class="status-item__value" :class="daemonClass">{{ daemonLabel }}</span>
          </div>
          <div class="status-item">
            <span class="status-item__label">活跃会话</span>
            <span class="status-item__value">{{ activeSessions }}</span>
          </div>
          <div class="status-item">
            <span class="status-item__label">运行中任务</span>
            <span class="status-item__value">{{ runningTasks }}</span>
          </div>
          <div class="status-item">
            <span class="status-item__label">已连接平台</span>
            <span class="status-item__value">{{ connectedPlatforms }}</span>
          </div>
          </div>
        </CardContent>
      </Card>

      <p v-if="loadError" class="admin-overview__error">部分指标加载失败：{{ loadError }}</p>
    </div>

    <div class="analytics-section">
      <div class="analytics-row analytics-row--duo">
        <Card class="analytics-card">
          <CardHeader>
            <CardTitle>Token 用量趋势</CardTitle>
            <CardDescription>近 {{ days }} 天输入 / 输出 Token(按天)</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart v-if="tokenTrend.length" :option="tokenTrendOption" height="260px" />
            <p v-else class="analytics-empty">{{ analyticsLoading ? '加载中…' : '暂无 Token 数据' }}</p>
          </CardContent>
        </Card>

        <Card class="analytics-card">
          <CardHeader>
            <CardTitle>模型用量分布</CardTitle>
            <CardDescription>近 {{ days }} 天各模型 Token 占比</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart v-if="modelUsage.length" :option="modelUsageOption" height="260px" />
            <p v-else class="analytics-empty">{{ analyticsLoading ? '加载中…' : '暂无模型用量' }}</p>
          </CardContent>
        </Card>
      </div>

      <Card class="analytics-card">
        <CardHeader>
          <CardTitle>活跃度热力图</CardTitle>
          <CardDescription>近 90 天调用活跃度(星期 × 小时)</CardDescription>
        </CardHeader>
        <CardContent>
          <EChart v-if="heatmap.length" :option="heatmapOption" height="300px" />
          <p v-else class="analytics-empty">{{ analyticsLoading ? '加载中…' : '暂无活跃数据' }}</p>
        </CardContent>
      </Card>

      <Card class="analytics-card">
        <CardHeader>
          <CardTitle>每日活跃度</CardTitle>
          <CardDescription>近 180 天每天的对话调用数</CardDescription>
        </CardHeader>
        <CardContent>
          <EChart v-if="dailyActivity.length" :option="dailyHeatmapOption" height="260px" />
          <p v-else class="analytics-empty">{{ analyticsLoading ? '加载中…' : '暂无活跃数据' }}</p>
        </CardContent>
      </Card>

      <p v-if="analyticsError" class="admin-overview__error">部分分析数据加载失败：{{ analyticsError }}</p>
    </div>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import PageLayout from '../components/PageLayout.vue';
import KpiCards from '../components/admin/KpiCards.vue';
import EChart from '../components/admin/EChart.vue';
import IconChevronLeft from '../components/icons/IconChevronLeft.vue';
import { Button } from '../components/ui/button';
import CustomSelect from '../components/ui/CustomSelect.vue';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { useDictionariesStore } from '../stores/dictionaries.js';
import { useThemeStore } from '../stores/theme.js';
import { listMCPServers } from '../api/mcpService';
import { listSkills } from '../api/skillLibrary';
import { getStatus as getDaemonStatus } from '../api/daemon';
import { getExecutionOverview } from '../api/monitoring';
import { getTokenTrend, getModelUsage, getActivityHeatmap, getDailyActivity } from '../api/analytics';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const dictStore = useDictionariesStore();
const themeStore = useThemeStore();
const counts = ref({ agents: null, providers: null, mcp: null, skills: null });
const daemonStatus = ref(null);
const overview = ref(null);
const loadError = ref('');

// 数据分析:token 趋势 / 模型用量 / 活跃热力图
const days = ref(7);
const dayOptions = [
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: '90', label: '近 90 天' },
];
const tokenTrend = ref([]);
const modelUsage = ref([]);
const heatmap = ref([]);
const dailyActivity = ref([]);
const analyticsError = ref('');
const analyticsLoading = ref(false);

const len = (v) => {
  if (Array.isArray(v)) return v.length;
  if (v && Array.isArray(v.servers)) return v.servers.length;
  if (v && Array.isArray(v.data)) return v.data.length;
  return null;
};

const kpiItems = computed(() => [
  { key: 'agents', label: 'Agent', value: counts.value.agents ?? '—' },
  { key: 'providers', label: '模型 Provider', value: counts.value.providers ?? '—' },
  { key: 'mcp', label: 'MCP 服务', value: counts.value.mcp ?? '—' },
  { key: 'skills', label: 'Skill', value: counts.value.skills ?? '—' },
]);

const daemonLabel = computed(() => {
  const s = daemonStatus.value;
  if (!s) return '未知';
  const running = s.daemon_running ?? s.running ?? s.is_running ?? (s.status === 'running');
  if (running === true) return '运行中';
  if (running === false) return '已停止';
  return s.status ? String(s.status) : '未知';
});
const daemonClass = computed(() => {
  const s = daemonStatus.value;
  const running = s && (s.daemon_running ?? s.running ?? s.is_running ?? (s.status === 'running'));
  if (running === true) return 'status-item__value--ok';
  if (running === false) return 'status-item__value--off';
  return '';
});

const activeSessions = computed(() => {
  const o = overview.value;
  if (!o) return '—';
  return o.active_sessions ?? o.activeSessions ?? o.summary?.active_sessions ?? '—';
});
const runningTasks = computed(() => {
  const o = overview.value;
  if (!o) return '—';
  const rt = o.running_tasks ?? o.runningTasks;
  if (typeof rt === 'number') return rt;
  if (Array.isArray(rt)) return rt.length;
  return o.summary?.running_tasks ?? '—';
});
const connectedPlatforms = computed(() => {
  const s = daemonStatus.value;
  if (!s) return '—';
  const platforms = s.platforms ?? s.connected_platforms;
  if (Array.isArray(platforms)) return platforms.length;
  if (typeof s.connected_platforms === 'number') return s.connected_platforms;
  return '—';
});

onMounted(async () => {
  const results = await Promise.allSettled([
    dictStore.ensureAgents(),
    dictStore.ensureProviders(),
    listMCPServers(),
    listSkills(),
    getDaemonStatus(),
    getExecutionOverview(),
  ]);
  const [agents, providers, mcp, skills, status, ov] = results;
  const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message).filter(Boolean);

  counts.value = {
    agents: agents.status === 'fulfilled' ? len(agents.value) : null,
    providers: providers.status === 'fulfilled' ? len(providers.value) : null,
    mcp: mcp.status === 'fulfilled' ? len(mcp.value) : null,
    skills: skills.status === 'fulfilled' ? (skills.value?.data?.length ?? len(skills.value)) : null,
  };
  daemonStatus.value = status.status === 'fulfilled' ? status.value : null;
  overview.value = ov.status === 'fulfilled' ? ov.value : null;
  loadError.value = failed.length ? failed.join('; ') : '';

  reloadAnalytics();
});

function buildHeatmapData(points) {
  // 后端返回稀疏点,补全 7×24 网格(缺位 0)。weekday 0=周日。
  const map = new Map();
  for (const p of points) map.set(`${p.weekday}-${p.hour}`, p.calls);
  const data = [];
  for (let w = 0; w < 7; w++) {
    for (let h = 0; h < 24; h++) {
      data.push([h, w, map.get(`${w}-${h}`) ?? 0]);
    }
  }
  return data;
}

async function reloadAnalytics() {
  analyticsLoading.value = true;
  analyticsError.value = '';
  const results = await Promise.allSettled([
    getTokenTrend({ days: days.value, bucket: 'day' }),
    getModelUsage({ days: days.value }),
    getActivityHeatmap({ days: 90 }),
    getDailyActivity({ days: 180 }),
  ]);
  const [trend, model, heat, daily] = results;
  tokenTrend.value = trend.status === 'fulfilled' ? trend.value : [];
  modelUsage.value = model.status === 'fulfilled' ? model.value : [];
  heatmap.value = heat.status === 'fulfilled' ? heat.value : [];
  dailyActivity.value = daily.status === 'fulfilled' ? daily.value : [];
  const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message).filter(Boolean);
  analyticsError.value = failed.length ? failed.join('; ') : '';
  analyticsLoading.value = false;
}

function onDaysChange(v) {
  days.value = Number(v);
  reloadAnalytics();
}

const tokenTrendOption = computed(() => {
  const isDark = themeStore.isDark;
  const labelColor = isDark ? '#a1a1aa' : '#52525b';
  const splitColor = isDark ? '#3f3f46' : '#e4e4e7';
  return {
    backgroundColor: 'transparent',
    textStyle: { color: labelColor },
    tooltip: { trigger: 'axis' },
    legend: { data: ['输入 Token', '输出 Token'], textStyle: { color: labelColor }, top: 0 },
    grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
    xAxis: { type: 'category', boundaryGap: false, data: tokenTrend.value.map((p) => p.ts), axisLabel: { color: labelColor } },
    yAxis: { type: 'value', axisLabel: { color: labelColor }, splitLine: { lineStyle: { color: splitColor } } },
    series: [
      { name: '输入 Token', type: 'line', smooth: true, areaStyle: { opacity: 0.15 }, data: tokenTrend.value.map((p) => p.token_in) },
      { name: '输出 Token', type: 'line', smooth: true, areaStyle: { opacity: 0.15 }, data: tokenTrend.value.map((p) => p.token_out) },
    ],
  };
});

const modelUsageOption = computed(() => {
  const isDark = themeStore.isDark;
  const labelColor = isDark ? '#a1a1aa' : '#52525b';
  return {
    backgroundColor: 'transparent',
    textStyle: { color: labelColor },
    tooltip: { trigger: 'item', formatter: '{b}: {c} tokens ({d}%)' },
    legend: { type: 'scroll', orient: 'vertical', right: 0, top: 'middle', textStyle: { color: labelColor } },
    series: [{
      type: 'pie',
      radius: ['45%', '70%'],
      center: ['38%', '50%'],
      avoidLabelOverlap: true,
      label: { show: false },
      data: modelUsage.value.map((m) => ({ name: m.model, value: m.tokens })),
    }],
  };
});

const heatmapOption = computed(() => {
  const isDark = themeStore.isDark;
  const labelColor = isDark ? '#a1a1aa' : '#52525b';
  const hours = Array.from({ length: 24 }, (_, i) => `${i}`);
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const maxCalls = Math.max(1, ...heatmap.value.map((p) => p.calls));
  return {
    backgroundColor: 'transparent',
    animation: true,
    animationDuration: 800,
    animationEasing: 'cubicOut',
    animationDurationUpdate: 400,
    textStyle: { color: labelColor },
    tooltip: { position: 'top' },
    grid: { left: 8, right: 24, top: 16, bottom: 70, containLabel: true },
    xAxis: { type: 'category', data: hours, splitArea: { show: false }, axisLabel: { color: labelColor } },
    yAxis: { type: 'category', data: weekdays, splitArea: { show: false }, axisLabel: { color: labelColor } },
    visualMap: {
      min: 0,
      max: maxCalls,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      textStyle: { color: labelColor },
      inRange: { color: isDark ? ['#27272a', '#6366f1'] : ['#f4f4f5', '#6366f1'] },
    },
    series: [{
      type: 'heatmap',
      data: buildHeatmapData(heatmap.value),
      label: { show: false },
      itemStyle: {
        borderColor: isDark ? '#18181b' : '#ffffff',
        borderWidth: 3,
        borderRadius: 3,
      },
      emphasis: { itemStyle: { borderColor: '#6366f1', borderWidth: 2 } },
    }],
  };
});

const dailyHeatmapOption = computed(() => {
  const isDark = themeStore.isDark;
  const labelColor = isDark ? '#a1a1aa' : '#52525b';
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 179);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const maxCalls = Math.max(1, ...dailyActivity.value.map((p) => p.calls));
  return {
    backgroundColor: 'transparent',
    animation: true,
    animationDuration: 800,
    animationEasing: 'cubicOut',
    animationDurationUpdate: 400,
    textStyle: { color: labelColor },
    tooltip: { formatter: (p) => `${p.value[0]}<br/>${p.value[1]} 次调用` },
    visualMap: {
      min: 0,
      max: maxCalls,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      textStyle: { color: labelColor },
      inRange: { color: isDark ? ['#27272a', '#6366f1'] : ['#f4f4f5', '#6366f1'] },
    },
    calendar: {
      top: 35,
      left: 50,
      right: 30,
      bottom: 75,
      range: [fmt(start), fmt(today)],
      cellSize: ['auto', 'auto'],
      itemStyle: {
        color: isDark ? '#27272a' : '#f4f4f5',
        borderColor: isDark ? '#18181b' : '#ffffff',
        borderWidth: 3,
        borderRadius: 3,
      },
      yearLabel: { show: false },
      monthLabel: { color: labelColor, nameMap: 'cn', margin: 8 },
      dayLabel: { color: labelColor, firstDay: 1, nameMap: 'cn', margin: 8 },
      splitLine: { show: false },
    },
    series: [{
      type: 'heatmap',
      coordinateSystem: 'calendar',
      data: dailyActivity.value.map((p) => [p.date, p.calls]),
      itemStyle: { borderRadius: 3 },
      emphasis: { itemStyle: { borderColor: '#6366f1', borderWidth: 2 } },
    }],
  };
});
</script>
<style scoped>
.admin-header-link {
  text-decoration: none;
}

.admin-overview {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--spacing-sm);
}

.status-item {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
  background: var(--color-bg-elevated);
}

.status-item__label {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.status-item__value {
  color: var(--color-text-primary);
  font-size: var(--font-size-lg);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.status-item__value--ok {
  color: var(--color-success);
}

.status-item__value--off {
  color: var(--color-text-muted);
}

.admin-overview__error {
  margin: 0;
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
  background: var(--color-warning-bg);
  color: var(--color-warning);
  font-size: var(--font-size-sm);
}

.admin-range-select { width: 120px; flex: 0 0 auto; }

.analytics-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.analytics-row--duo {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--spacing-md);
}

.analytics-card { overflow: hidden; }

.analytics-empty {
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 260px;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

@media (max-width: 900px) {
  .analytics-row--duo { grid-template-columns: 1fr; }
}
</style>
