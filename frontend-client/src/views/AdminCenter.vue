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
        title="时间范围作用于 Token 趋势与模型分布；热力图与日历图为固定窗口"
        @update:model-value="onDaysChange"
      />
      <Button as-child variant="ghost" size="icon-sm" class="admin-header-link" aria-label="返回工作台" title="返回工作台">
        <RouterLink :to="chatReturnPath"><IconChevronLeft :size="16" /></RouterLink>
      </Button>
    </template>

    <KpiCards :items="kpiItems" />

    <p v-if="loadError" class="admin-overview__error">部分指标加载失败：{{ loadError }}</p>

    <div class="analytics-section">
      <div class="analytics-row analytics-row--duo">
        <Card class="analytics-card">
          <CardHeader>
            <CardTitle>Token 用量趋势</CardTitle>
            <CardDescription>近 {{ days }} 天输入 / 输出 Token(按天)</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart v-if="tokenTrend.length" :option="tokenTrendOption" height="260px" />
            <div v-else-if="analyticsLoading" class="analytics-empty" aria-busy="true">
              <span class="g-spinner" aria-hidden="true"></span>加载中…
            </div>
            <p v-else class="analytics-empty">暂无 Token 数据</p>
          </CardContent>
        </Card>

        <Card class="analytics-card">
          <CardHeader>
            <CardTitle>模型用量分布</CardTitle>
            <CardDescription>近 {{ days }} 天各模型 Token 占比</CardDescription>
          </CardHeader>
          <CardContent>
            <EChart v-if="modelUsage.length" :option="modelUsageOption" height="260px" />
            <div v-else-if="analyticsLoading" class="analytics-empty" aria-busy="true">
              <span class="g-spinner" aria-hidden="true"></span>加载中…
            </div>
            <p v-else class="analytics-empty">暂无模型用量</p>
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
          <div v-else-if="analyticsLoading" class="analytics-empty" aria-busy="true">
            <span class="g-spinner" aria-hidden="true"></span>加载中…
          </div>
          <p v-else class="analytics-empty">暂无活跃数据</p>
        </CardContent>
      </Card>

      <Card class="analytics-card">
        <CardHeader>
          <CardTitle>每日活跃度</CardTitle>
          <CardDescription>近 180 天每天的对话调用数</CardDescription>
        </CardHeader>
        <CardContent>
          <EChart v-if="dailyActivity.length" :option="dailyHeatmapOption" height="260px" />
          <div v-else-if="analyticsLoading" class="analytics-empty" aria-busy="true">
            <span class="g-spinner" aria-hidden="true"></span>加载中…
          </div>
          <p v-else class="analytics-empty">暂无活跃数据</p>
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
import { getTokenTrend, getModelUsage, getActivityHeatmap, getDailyActivity } from '../api/analytics';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const dictStore = useDictionariesStore();
const themeStore = useThemeStore();
const counts = ref({ teams: null, providers: null, mcp: null, skills: null });
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
  // Agent 配置是 { name: config } 对象映射，按 key 计数
  if (v && typeof v === 'object') return Object.keys(v).length;
  return null;
};

// 资源存量 KPI：Team / Provider / MCP / Skill
const kpiItems = computed(() => [
  { key: 'teams', label: 'Team', value: counts.value.teams ?? '—' },
  { key: 'providers', label: '模型 Provider', value: counts.value.providers ?? '—' },
  { key: 'mcp', label: 'MCP 服务', value: counts.value.mcp ?? '—' },
  { key: 'skills', label: 'Skill', value: counts.value.skills ?? '—' },
]);
onMounted(async () => {
  const results = await Promise.allSettled([
    dictStore.ensureTeams(),
    dictStore.ensureProviders(),
    listMCPServers(),
    listSkills(),
  ]);
  const [teams, providers, mcp, skills] = results;
  const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason?.message).filter(Boolean);

  counts.value = {
    teams: teams.status === 'fulfilled' ? len(teams.value?.teams) : null,
    providers: providers.status === 'fulfilled' ? len(providers.value) : null,
    mcp: mcp.status === 'fulfilled' ? len(mcp.value) : null,
    skills: skills.status === 'fulfilled' ? (skills.value?.data?.length ?? len(skills.value)) : null,
  };
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

// 读 CSS token：ECharts 不接受 CSS var，需解析为具体色值；主题切换时 computed 因 isDark 依赖重算，自动跟随
const readCssToken = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const tokenTrendOption = computed(() => {
  void themeStore.isDark; // 主题切换时重算，readCssToken 重读新主题
  const labelColor = readCssToken('--color-text-muted');
  const splitColor = readCssToken('--color-border');
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
  void themeStore.isDark; // 主题切换时重算，readCssToken 重读新主题
  const labelColor = readCssToken('--color-text-muted');
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
  void themeStore.isDark; // 主题切换时重算，readCssToken 重读新主题
  const labelColor = readCssToken('--color-text-muted');
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
      inRange: { color: [readCssToken('--color-bg-secondary'), readCssToken('--color-brand-accent')] },
    },
    series: [{
      type: 'heatmap',
      data: buildHeatmapData(heatmap.value),
      label: { show: false },
      itemStyle: {
        borderColor: readCssToken('--color-bg-elevated'),
        borderWidth: 3,
        borderRadius: 3,
      },
      emphasis: { itemStyle: { borderColor: readCssToken('--color-brand-accent'), borderWidth: 2 } },
    }],
  };
});

const dailyHeatmapOption = computed(() => {
  void themeStore.isDark; // 主题切换时重算，readCssToken 重读新主题
  const labelColor = readCssToken('--color-text-muted');
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
      inRange: { color: [readCssToken('--color-bg-secondary'), readCssToken('--color-brand-accent')] },
    },
    calendar: {
      top: 35,
      left: 50,
      right: 30,
      bottom: 75,
      range: [fmt(start), fmt(today)],
      cellSize: ['auto', 'auto'],
      itemStyle: {
        color: readCssToken('--color-bg-secondary'),
        borderColor: readCssToken('--color-bg-elevated'),
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
      emphasis: { itemStyle: { borderColor: readCssToken('--color-brand-accent'), borderWidth: 2 } },
    }],
  };
});
</script>
<style scoped>
.admin-header-link {
  text-decoration: none;
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
  gap: var(--spacing-sm);
  height: 260px;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

@media (max-width: 900px) {
  .analytics-row--duo { grid-template-columns: 1fr; }
}
</style>
