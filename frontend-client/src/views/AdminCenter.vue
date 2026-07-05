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
      <Button as-child variant="ghost" size="icon-sm" class="admin-header-link" aria-label="返回工作台" title="返回工作台">
        <RouterLink :to="chatReturnPath"><IconChevronLeft :size="16" /></RouterLink>
      </Button>
    </template>

    <KpiCards :items="kpiItems" />

    <div class="admin-overview">
      <section class="adm-panel">
        <header class="adm-panel__header">
          <div class="adm-panel__title-block">
            <h2 class="adm-panel__title">系统状态</h2>
            <p class="adm-panel__description">守护进程与执行平面实时状态（从左侧导航进入各模块管理）</p>
          </div>
        </header>
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
      </section>

      <p v-if="loadError" class="admin-overview__error">部分指标加载失败：{{ loadError }}</p>
    </div>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import PageLayout from '../components/PageLayout.vue';
import KpiCards from '../components/admin/KpiCards.vue';
import IconChevronLeft from '../components/icons/IconChevronLeft.vue';
import { Button } from '../components/ui/button';
import { useDictionariesStore } from '../stores/dictionaries.js';
import { listMCPServers } from '../api/mcpService';
import { listSkills } from '../api/skillLibrary';
import { getStatus as getDaemonStatus } from '../api/daemon';
import { getExecutionOverview } from '../api/monitoring';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const dictStore = useDictionariesStore();
const counts = ref({ agents: null, providers: null, mcp: null, skills: null });
const daemonStatus = ref(null);
const overview = ref(null);
const loadError = ref('');

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
</style>
