<template>
  <PageLayout
    title="Team 编排"
    subtitle="可视化装配 Agent 配置方案"
    mobile-title="Team 编排"
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    mobile-content-padding="var(--spacing-sm)"
  >
    <div class="team-builder-page">
      <EntityListLayout
        v-if="loading || error"
        title="Team 编排数据"
        description="加载 Team、Agent 映射与当前生效状态。"
        :loading="loading"
        loading-text="加载 Team 配置中..."
        :error="error"
        @retry="loadTeams"
      />

      <template v-else>
        <KpiCards :items="kpiItems" />

        <section class="glass-card builder-panel builder-panel--split">
          <div class="split-block">
            <div class="split-block__head">
              <h2 class="section-title">切换生效 Team</h2>
              <p class="section-desc">切换后，Agent 配置页会直接编辑当前 Team 对应的配置文件。</p>
            </div>
            <div class="split-block__body">
              <label class="form-item">
                <span class="field-label-text">Active Team</span>
                <CustomSelect :model-value="activeTeam" :options="teamOptions" placeholder="选择 Team" @update:model-value="handleActivateTeam" />
              </label>
              <div class="section-actions">
                <UiButton variant="primary" :disabled="working || !activeTeam" @click="goToAgentConfig">前往当前 Team 配置页</UiButton>
              </div>
            </div>
          </div>

          <div class="split-block">
            <div class="split-block__head">
              <h2 class="section-title">创建新方案</h2>
              <p class="section-desc">可空白创建，也可基于已有 Team 整体复制一份。</p>
            </div>
            <div class="split-block__body">
              <div class="form-grid">
                <label class="form-item">
                  <span class="field-label-text">新 Team 名称</span>
                  <input v-model.trim="newTeamName" type="text" class="form-control" placeholder="例如 research_v2" />
                </label>
                <label class="form-item">
                  <span class="field-label-text">复制来源</span>
                  <CustomSelect :model-value="sourceTeam" :options="[{ value: '', label: '空白创建' }, ...teamOptions]" placeholder="选择来源 Team" @update:model-value="sourceTeam = $event" />
                </label>
              </div>
              <div class="section-actions">
                <UiButton variant="primary" :disabled="working" @click="handleCreateTeam">创建 Team</UiButton>
              </div>
            </div>
          </div>
        </section>

        <section class="glass-card builder-panel">
          <div class="section-toolbar">
            <div>
              <h2 class="section-title">可视化装配台</h2>
              <p class="section-desc">从来源 Team 选择 Agent，右侧预览目标 Team 当前内容，再将选中项增量复制过去。</p>
            </div>
          </div>

          <div class="composition-toolbar">
            <div class="form-grid">
              <label class="form-item">
                <span class="field-label-text">来源 Team</span>
                <CustomSelect :model-value="copySourceTeam" :options="teamOptions" placeholder="选择来源 Team" @update:model-value="handleCopySourceChange" />
              </label>
              <label class="form-item">
                <span class="field-label-text">目标 Team</span>
                <CustomSelect :model-value="copyTargetTeam" :options="teamOptions" placeholder="选择目标 Team" @update:model-value="copyTargetTeam = $event" />
              </label>
            </div>
            <div class="composition-meta">
              <div class="selection-overview">
                <span class="selection-stat">已选 <strong>{{ selectedCopyAgents.length }}</strong> 个</span>
                <button class="selection-clear-btn" :disabled="selectedCopyAgents.length === 0" @click="clearSelectedAgents">清空</button>
              </div>
              <div class="composition-bulk">
                <UiButton variant="ghost" :disabled="availableSourceAgents.length === 0" @click="selectAllAvailableAgents">全选可新增</UiButton>
                <UiButton variant="ghost" :disabled="copySourceAgents.length === 0" @click="selectAllSourceAgents">全选来源</UiButton>
              </div>
              <span class="selection-hint">可新增 {{ availableSourceAgents.length }} · 已存在 {{ conflictingSelectedAgents.length }}</span>
            </div>
          </div>

          <div class="composition-board">
            <article class="board-column board-column--source">
              <div class="board-column__head">
                <div>
                  <div class="board-caption">来源 Team</div>
                  <h3>{{ copySourceTeam || '未选择来源' }}</h3>
                </div>
                <span class="board-metric">{{ copySourceAgents.length }} Agents</span>
              </div>
              <div v-if="copySourceAgents.length" class="agent-card-list">
                <button
                  v-for="agent in copySourceAgents"
                  :key="`source-${agent}`"
                  type="button"
                  class="agent-card"
                  :class="{ 'agent-card--selected': selectedCopyAgents.includes(agent), 'agent-card--conflict': targetAgentSet.has(agent) && copySourceTeam !== copyTargetTeam, 'agent-card--fresh': !targetAgentSet.has(agent) || copySourceTeam === copyTargetTeam }"
                  @click="toggleCopyAgent(agent)"
                >
                  <span class="agent-card__status" :class="{ 'agent-card__status--selected': selectedCopyAgents.includes(agent) }"></span>
                  <span class="agent-card__name">{{ agent }}</span>
                  <span class="agent-card__action">{{ agentCardAction(agent) }}</span>
                </button>
              </div>
              <div v-else class="empty-inline">当前来源 Team 暂无可复制的 Agent</div>
            </article>

            <article class="board-transfer">
              <div class="transfer-stack">
                <div class="transfer-badge">已选 <strong>{{ selectedCopyAgents.length }}</strong> / {{ copySourceAgents.length }}</div>
                <svg class="transfer-arrow" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="5" y1="12" x2="19" y2="12"/>
                  <polyline points="12 5 19 12 12 19"/>
                </svg>
                <UiButton class="transfer-button" variant="primary" :disabled="working" @click="handleCopyAgents">复制到目标</UiButton>
                <p class="transfer-hint">增量复制 · 不覆盖目标已有 Agent</p>
              </div>
            </article>

            <article class="board-column board-column--target">
              <div class="board-column__head">
                <div>
                  <div class="board-caption">目标 Team</div>
                  <h3>{{ copyTargetTeam || '未选择目标' }}</h3>
                </div>
                <span class="board-metric">{{ copyTargetAgents.length }} Agents</span>
              </div>
              <div v-if="copyTargetAgents.length" class="target-list">
                <div v-for="agent in copyTargetAgents" :key="`target-${agent}`" class="target-row" :class="{ 'target-row--incoming': selectedCopyAgents.includes(agent) && copySourceTeam !== copyTargetTeam }">
                  <span class="target-row__dot"></span>
                  <span class="target-row__name">{{ agent }}</span>
                  <span v-if="selectedCopyAgents.includes(agent) && copySourceTeam !== copyTargetTeam" class="target-row__tag">去重</span>
                </div>
              </div>
              <div v-else class="empty-inline">当前目标 Team 还没有 Agent，可直接从左侧装配</div>
            </article>
          </div>

          <div class="plan-preview">
            <div class="plan-preview__head">
              <div class="plan-preview__lead">
                <span class="board-caption">复制预览</span>
                <span>即将写入 <strong>{{ copyTargetTeam || '目标 Team' }}</strong></span>
              </div>
              <div class="plan-preview__stats">
                <span class="plan-stat"><strong>{{ incomingSelectedAgents.length }}</strong>新增</span>
                <span v-if="conflictingSelectedAgents.length" class="plan-stat plan-stat--warning"><strong>{{ conflictingSelectedAgents.length }}</strong>已存在</span>
                <span class="plan-stat"><strong>{{ projectedTargetAgentCount }}</strong>复制后总数</span>
              </div>
            </div>
            <div v-if="selectedCopyAgents.length" class="agent-chip-list">
              <span v-for="agent in selectedCopyAgents" :key="`preview-${agent}`" class="agent-chip" :class="targetAgentSet.has(agent) && copySourceTeam !== copyTargetTeam ? 'agent-chip--warning' : 'agent-chip--active'">
                <span class="agent-chip__dot"></span>{{ agent }}
              </span>
            </div>
            <div v-else class="plan-preview__empty">先从左侧选择 Agent，这里实时汇总待复制清单。</div>
          </div>
        </section>

        <EntityListLayout
          title="Team 列表"
          description="每个 Team 对应一个独立配置文件，可单独激活、删除，并继续进入配置页细调。"
          :empty="teams.length === 0"
          empty-title="暂无 Team"
          empty-hint="创建 Team 后会显示在这里。"
        >
          <div class="team-list adm-entity-list">
            <article v-for="team in teams" :key="team.team_name" class="team-card adm-entity-row" :class="{ 'team-card--active': team.is_active }">
              <div class="team-card__main">
                <div class="team-card__identity">
                  <div class="team-card__title-row">
                    <h3>{{ team.team_name }}</h3>
                    <UiBadge class="team-badge" size="sm" :tone="team.is_active ? 'success' : 'neutral'">{{ team.is_active ? '当前生效' : `${team.agent_count} Agents` }}</UiBadge>
                  </div>
                  <p>{{ team.file_path }}</p>
                </div>
                <div class="section-actions section-actions--compact adm-action-row">
                  <button class="adm-action-btn adm-action-btn--success" :disabled="working || team.is_active" @click="handleActivateTeam(team.team_name)">激活</button>
                  <button class="adm-action-btn" @click="openTeamConfig(team.team_name)">细调配置</button>
                  <button v-if="team.team_name === 'default'" class="adm-action-btn adm-action-btn--warning" :disabled="working" @click="handleResetDefaultTeam">恢复默认</button>
                  <button class="adm-action-btn adm-action-btn--danger" :disabled="working || team.is_active || teams.length <= 1" @click="handleDeleteTeam(team.team_name)">删除</button>
                </div>
              </div>
              <div v-if="team.agents && team.agents.length" class="team-card__agents">
                <span v-for="agent in team.agents" :key="`${team.team_name}-${agent}`" class="team-agent-tag adm-chip" :title="agent">{{ agentDisplayMap[agent] || agent }}</span>
              </div>
            </article>
          </div>
        </EntityListLayout>
      </template>
    </div>
  </PageLayout>
</template>

<script setup>
import { computed, h, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageLayout from '../components/PageLayout.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import KpiCards from '../components/admin/KpiCards.vue';
import CustomSelect from '../components/CustomSelect.vue';
import { UiBadge, UiButton } from '../components/ui';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { activateTeam, copyAgentsToTeam, createTeam, deleteTeam, resetDefaultTeam } from '../api/agentConfig';
import { useDictionariesStore } from '../stores/dictionaries.js';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const router = useRouter();
const dictStore = useDictionariesStore();

const SVG = { xmlns: 'http://www.w3.org/2000/svg', width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
const IconActive = () => h('svg', SVG, [h('path', { d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' }), h('polyline', { points: '22 4 12 14.01 9 11.01' })]);
const IconTotal = () => h('svg', SVG, [h('rect', { x: 3, y: 4, width: 7, height: 7, rx: 1 }), h('rect', { x: 14, y: 4, width: 7, height: 7, rx: 1 }), h('rect', { x: 14, y: 15, width: 7, height: 7, rx: 1 })]);
const IconAgents = () => h('svg', SVG, [h('path', { d: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }), h('circle', { cx: 8.5, cy: 7, r: 4 }), h('path', { d: 'M20 8v6' }), h('path', { d: 'M23 11h-6' })]);

const loading = ref(false);
const error = ref('');
const activeTeam = ref('');
const teams = ref([]);
const agentDisplayMap = ref({});
const newTeamName = ref('');
const sourceTeam = ref('');
const copySourceTeam = ref('');
const copyTargetTeam = ref('');
const selectedCopyAgents = ref([]);

const teamOptions = computed(() => teams.value.map((team) => ({ value: team.team_name, label: team.team_name })));
const activeTeamInfo = computed(() => teams.value.find((team) => team.team_name === activeTeam.value) || null);
const copySourceInfo = computed(() => teams.value.find((team) => team.team_name === copySourceTeam.value) || null);
const copyTargetInfo = computed(() => teams.value.find((team) => team.team_name === copyTargetTeam.value) || null);
const copySourceAgents = computed(() => copySourceInfo.value?.agents || []);
const copyTargetAgents = computed(() => copyTargetInfo.value?.agents || []);
const targetAgentSet = computed(() => new Set(copyTargetAgents.value));
const incomingSelectedAgents = computed(() => selectedCopyAgents.value.filter((agent) => !targetAgentSet.value.has(agent) || copySourceTeam.value === copyTargetTeam.value));
const conflictingSelectedAgents = computed(() => selectedCopyAgents.value.filter((agent) => targetAgentSet.value.has(agent) && copySourceTeam.value !== copyTargetTeam.value));
const availableSourceAgents = computed(() => copySourceAgents.value.filter((agent) => !targetAgentSet.value.has(agent) || copySourceTeam.value === copyTargetTeam.value));
const projectedTargetAgentCount = computed(() => copyTargetAgents.value.length + incomingSelectedAgents.value.filter((agent) => !copyTargetAgents.value.includes(agent)).length);

const kpiItems = computed(() => [
  { key: 'active', label: '当前 Team', value: activeTeam.value || '未选择', icon: IconActive },
  { key: 'total', label: 'Team 总数', value: teams.value.length, icon: IconTotal },
  { key: 'agents', label: '当前 Agent 数', value: activeTeamInfo.value?.agent_count || 0, icon: IconAgents },
]);

function normalizeSelections() {
  selectedCopyAgents.value = selectedCopyAgents.value.filter((agent) => copySourceAgents.value.includes(agent));
}

const { run: runLoadTeams } = useAsyncAction(
  async (force = false) => {
    const result = await dictStore.ensureTeams(force);
    activeTeam.value = result.active_team || '';
    teams.value = Array.isArray(result.teams) ? result.teams : [];
    const configs = await dictStore.ensureAgents(force).catch(() => ({}));
    agentDisplayMap.value = Object.fromEntries(
      Object.entries(configs || {}).map(([name, cfg]) => [name, cfg?.display_name || name]),
    );
    if (!copySourceTeam.value && teams.value.length > 0) copySourceTeam.value = teams.value[0].team_name;
    if (!copyTargetTeam.value && activeTeam.value) copyTargetTeam.value = activeTeam.value;
    normalizeSelections();
  },
  { errorPrefix: '加载 Team 列表失败', showErrorToast: false, onError: (e) => { error.value = e?.message || '加载 Team 列表失败'; } },
);
async function loadTeams() {
  loading.value = true;
  error.value = '';
  await runLoadTeams();
  loading.value = false;
}

const { run: runCreateTeam, loading: creating } = useAsyncAction(
  async () => {
    if (!newTeamName.value) throw new Error('请输入新的 Team 名称');
    const result = await createTeam({ team_name: newTeamName.value, source_team: sourceTeam.value || undefined });
    activeTeam.value = result.active_team || activeTeam.value;
    teams.value = Array.isArray(result.teams) ? result.teams : teams.value;
    copyTargetTeam.value = newTeamName.value;
    newTeamName.value = '';
    await runLoadTeams(true);
  },
  { successMessage: 'Team 创建成功', errorPrefix: '创建 Team 失败' },
);
function handleCreateTeam() { runCreateTeam(); }

const { run: runActivateTeam, loading: activating } = useAsyncAction(
  async (teamName) => {
    if (!teamName || teamName === activeTeam.value) return;
    const result = await activateTeam(teamName);
    activeTeam.value = result.active_team || teamName;
    teams.value = Array.isArray(result.teams) ? result.teams : teams.value;
    copyTargetTeam.value = activeTeam.value;
    await runLoadTeams(true);
  },
  { successMessage: (r, teamName) => `已切换到 Team：${teamName}`, errorPrefix: '切换 Team 失败' },
);
function handleActivateTeam(teamName) { runActivateTeam(teamName); }

function handleCopySourceChange(teamName) {
  copySourceTeam.value = teamName;
  selectedCopyAgents.value = [];
}
function toggleCopyAgent(agentName) {
  if (selectedCopyAgents.value.includes(agentName)) {
    selectedCopyAgents.value = selectedCopyAgents.value.filter((item) => item !== agentName);
    return;
  }
  selectedCopyAgents.value = [...selectedCopyAgents.value, agentName];
}
function agentCardAction(agentName) {
  const conflict = targetAgentSet.value.has(agentName) && copySourceTeam.value !== copyTargetTeam.value;
  const selected = selectedCopyAgents.value.includes(agentName);
  if (conflict && selected) return '去重';
  if (conflict) return '已存在';
  if (selected) return '待新增';
  return '选择';
}
function clearSelectedAgents() { selectedCopyAgents.value = []; }
function selectAllSourceAgents() { selectedCopyAgents.value = [...copySourceAgents.value]; }
function selectAllAvailableAgents() { selectedCopyAgents.value = [...availableSourceAgents.value]; }

const { run: runCopyAgents, loading: copying } = useAsyncAction(
  async () => {
    if (!copySourceTeam.value || !copyTargetTeam.value) throw new Error('请选择来源 Team 和目标 Team');
    if (selectedCopyAgents.value.length === 0) throw new Error('请选择至少一个 Agent');
    await copyAgentsToTeam(copyTargetTeam.value, copySourceTeam.value, selectedCopyAgents.value);
    selectedCopyAgents.value = [];
    await runLoadTeams(true);
  },
  {
    successMessage: () => {
      const copied = incomingSelectedAgents.value.length;
      const skipped = conflictingSelectedAgents.value.length;
      return skipped > 0 ? `复制完成：新增 ${copied} 个，已存在 ${skipped} 个` : `复制完成：新增 ${copied} 个 Agent`;
    },
    errorPrefix: '复制 Agent 失败',
  },
);
function handleCopyAgents() { runCopyAgents(); }

const { run: runDeleteTeam, loading: deleting } = useAsyncAction(
  async (teamName) => {
    await deleteTeam(teamName);
    if (copyTargetTeam.value === teamName) copyTargetTeam.value = activeTeam.value;
    if (copySourceTeam.value === teamName) {
      copySourceTeam.value = teams.value[0]?.team_name || '';
      selectedCopyAgents.value = [];
    }
    await runLoadTeams(true);
  },
  { successMessage: 'Team 删除成功', errorPrefix: '删除 Team 失败' },
);
function handleDeleteTeam(teamName) { runDeleteTeam(teamName); }

const { run: runResetDefault, loading: resetting } = useAsyncAction(
  async () => { await resetDefaultTeam(); await runLoadTeams(true); },
  { successMessage: 'default team 已重置为系统默认配置', errorPrefix: '重置 default team 失败' },
);
function handleResetDefaultTeam() { runResetDefault(); }

const working = computed(() => creating.value || copying.value || activating.value || deleting.value || resetting.value);

function goToAgentConfig() { router.push('/agent-config'); }
async function openTeamConfig(teamName) {
  if (teamName && teamName !== activeTeam.value) await runActivateTeam(teamName);
  router.push('/agent-config');
}

onMounted(() => { loadTeams(); });
</script>

<style scoped>
.team-builder-page { display: flex; flex-direction: column; gap: var(--spacing-lg); }

.panel-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }
.glass-card.builder-panel { position: relative; overflow: visible; padding: var(--spacing-lg); border-radius: var(--radius-xl); border: 1px solid var(--color-border); background: var(--color-hover-overlay); }
.glass-card.builder-panel--split { display: grid; grid-template-columns: minmax(0, 0.82fr) minmax(0, 1.18fr); gap: 0; padding: 0; overflow: hidden; }
.split-block { padding: var(--spacing-lg); display: flex; flex-direction: column; gap: var(--spacing-md); min-width: 0; }
.split-block + .split-block { border-left: 1px solid var(--color-border); }
.split-block__head { display: flex; flex-direction: column; gap: 6px; }
.split-block__head .section-title { font-size: var(--font-size-base); }
.split-block__body { display: flex; flex-direction: column; gap: var(--spacing-md); flex: 1; }

.section-toolbar, .section-actions, .inline-actions, .selection-overview { display: flex; justify-content: space-between; align-items: center; gap: var(--spacing-md); flex-wrap: wrap; }
.inline-actions--wrap { justify-content: flex-start; }
.section-toolbar { margin-bottom: var(--spacing-md); }
.section-title { margin: 0; font-size: var(--font-size-lg); font-weight: 650; letter-spacing: 0; color: var(--color-text-primary); }
.section-desc { margin: 6px 0 0; font-size: var(--font-size-sm); line-height: 1.55; color: var(--color-text-secondary); }

.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }
.form-grid--triple { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.form-item { position: relative; z-index: 0; display: flex; flex-direction: column; gap: var(--spacing-sm); }
.form-item:focus-within { z-index: 30; }
.form-item--wide { width: min(420px, 100%); }
.field-label-text, .board-caption { font-size: var(--font-size-xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-secondary); }

.selection-overview { min-height: 44px; padding: 0 14px; border-radius: var(--radius-lg); border: 1px solid var(--color-border); background: var(--color-hover-overlay); }
.selection-clear-btn { border: none; background: transparent; padding: 0; color: var(--color-brand-accent-light); font-size: var(--font-size-xs); cursor: pointer; transition: color var(--transition-fast); }
.selection-clear-btn:hover:not(:disabled) { color: var(--color-text-primary); }
.selection-clear-btn:disabled { color: var(--color-text-muted); cursor: default; }
.selection-stat, .board-metric, .selection-hint { font-size: var(--font-size-xs); color: var(--color-text-secondary); }

.composition-meta { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); flex-wrap: wrap; margin-top: var(--spacing-md); padding-top: var(--spacing-md); border-top: 1px solid var(--color-border); }
.composition-bulk { display: inline-flex; align-items: center; gap: var(--spacing-sm); }
.composition-toolbar { position: relative; z-index: 20; margin-bottom: var(--spacing-md); }
.composition-board { display: grid; grid-template-columns: minmax(0, 1fr) 168px minmax(0, 1fr); gap: var(--spacing-md); align-items: stretch; }

.board-column { padding: var(--spacing-lg); border-radius: var(--radius-xl); border: 1px solid var(--color-border); background: var(--color-hover-overlay); }
.board-column__head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--spacing-md); margin-bottom: var(--spacing-md); }
.board-column__head h3 { margin: 6px 0 0; font-size: var(--font-size-lg); font-weight: 600; color: var(--color-text-primary); }

.agent-card-list { display: flex; flex-direction: column; gap: 6px; }
.agent-card { width: 100%; padding: 10px 12px; border-radius: var(--radius-md); border: 1px solid var(--color-border); background: var(--color-hover-overlay); color: var(--color-text-primary); display: flex; align-items: center; gap: 10px; text-align: left; cursor: pointer; transition: border-color var(--transition-fast), background var(--transition-fast); }
.agent-card:hover { border-color: var(--color-border-hover); background: var(--color-hover-overlay-md); }
.agent-card--selected { border-color: rgba(var(--color-brand-accent-rgb), 0.45); background: rgba(var(--color-brand-accent-rgb), 0.12); }
.agent-card--conflict { border-color: rgba(var(--color-warning-rgb), 0.3); background: rgba(var(--color-warning-rgb), 0.08); }
.agent-card--fresh { border-color: rgba(var(--color-success-rgb), 0.22); }
.agent-card__status { width: 8px; height: 8px; flex: 0 0 auto; border-radius: var(--radius-full); background: var(--color-text-muted); }
.agent-card__status--selected { background: var(--color-brand-accent-light); }
.agent-card__name { flex: 1; min-width: 0; font-size: var(--font-size-sm); font-weight: 500; color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-card__action { font-size: var(--font-size-xs); font-weight: 600; color: var(--color-text-muted); white-space: nowrap; flex-shrink: 0; }
.agent-card--selected .agent-card__action { color: var(--color-brand-accent-light); }
.agent-card--conflict.agent-card--selected .agent-card__action { color: var(--color-warning); }
.transfer-hint { font-size: var(--font-size-xs); color: var(--color-text-secondary); }

.board-transfer { display: flex; align-items: center; justify-content: center; }
.transfer-stack { width: 100%; display: flex; flex-direction: column; align-items: center; gap: var(--spacing-md); padding: var(--spacing-sm) 0; text-align: center; }
.transfer-badge { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
.transfer-badge strong { font-size: var(--font-size-base); font-weight: 650; color: var(--color-text-primary); }
.transfer-arrow { color: var(--color-text-muted); flex-shrink: 0; }
.transfer-button { width: 100%; }

.team-card__agents, .agent-chip-list { display: flex; flex-wrap: wrap; gap: 10px; }
.team-agent-tag, .agent-chip { display: inline-flex; align-items: center; gap: var(--spacing-sm); padding: 8px 12px; border-radius: var(--radius-full); border: 1px solid var(--color-border); background: var(--color-hover-overlay); color: var(--color-text-primary); font-size: var(--font-size-xs); }
.team-agent-tag { max-width: 100%; padding: 4px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-chip__dot { width: 7px; height: 7px; border-radius: var(--radius-full); background: var(--color-text-muted); }
.agent-chip--active { background: rgba(var(--color-brand-accent-rgb), 0.12); border-color: rgba(var(--color-brand-accent-rgb), 0.38); }
.agent-chip--warning { background: rgba(var(--color-warning-rgb), 0.08); border-color: rgba(var(--color-warning-rgb), 0.3); }
.agent-chip--active .agent-chip__dot, .agent-chip--warning .agent-chip__dot { background: var(--color-brand-accent-light); }

.target-list { display: flex; flex-direction: column; gap: 6px; }
.target-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-md); border: 1px solid var(--color-border); background: var(--color-hover-overlay); }
.target-row__dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: var(--radius-full); background: var(--color-text-muted); }
.target-row--incoming { border-color: rgba(var(--color-warning-rgb), 0.3); background: rgba(var(--color-warning-rgb), 0.08); }
.target-row--incoming .target-row__dot { background: var(--color-warning); }
.target-row__name { flex: 1; min-width: 0; font-size: var(--font-size-sm); color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.target-row__tag { font-size: var(--font-size-xs); font-weight: 600; color: var(--color-warning); white-space: nowrap; flex-shrink: 0; }

.plan-preview { margin-top: var(--spacing-md); padding-top: var(--spacing-md); border-top: 1px solid var(--color-border); }
.plan-preview__head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); flex-wrap: wrap; margin-bottom: var(--spacing-sm); }
.plan-preview__lead { display: inline-flex; align-items: baseline; gap: var(--spacing-sm); min-width: 0; font-size: var(--font-size-sm); color: var(--color-text-secondary); }
.plan-preview__lead strong { color: var(--color-text-primary); font-weight: 600; }
.plan-preview__stats { display: inline-flex; align-items: center; gap: var(--spacing-md); flex-wrap: wrap; }
.plan-stat { display: inline-flex; align-items: baseline; gap: 4px; font-size: var(--font-size-xs); color: var(--color-text-secondary); }
.plan-stat strong { font-size: var(--font-size-base); font-weight: 650; color: var(--color-text-primary); }
.plan-stat--warning strong { color: var(--color-warning); }
.plan-preview__empty { font-size: var(--font-size-xs); color: var(--color-text-muted); padding: 4px 0; }

.empty-inline { padding: 18px 14px; border-radius: var(--radius-lg); background: var(--color-hover-overlay); color: var(--color-text-secondary); text-align: center; font-size: var(--font-size-sm); }
.empty-inline--compact { padding-block: 14px; }

.team-list { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.team-card { display: flex; flex-direction: column; gap: var(--spacing-md); padding: 14px; border-radius: var(--radius-lg); transition: border-color var(--transition-fast), background var(--transition-fast); }
.team-card--active { border-color: rgba(var(--color-brand-accent-rgb), 0.35); background: rgba(var(--color-brand-accent-rgb), 0.05); }
.team-card__main { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing-md); }
.team-card__identity { min-width: 0; flex: 1; }
.team-card__title-row { display: flex; align-items: center; gap: var(--spacing-sm); flex-wrap: wrap; }
.team-card__title-row h3 { margin: 0; font-size: var(--font-size-base); line-height: 1.25; color: var(--color-text-primary); }
.team-card__identity p { margin: 6px 0 0; font-size: var(--font-size-xs); line-height: 1.45; color: var(--color-text-secondary); word-break: break-all; }
.team-badge { flex: 0 0 auto; white-space: nowrap; }
.section-actions--compact { justify-content: flex-end; }

@media (max-width: 900px) {
  .composition-board { grid-template-columns: 1fr; }
  .board-transfer { order: 2; }
  .board-column--target { order: 3; }
  .panel-grid, .form-grid, .form-grid--triple { grid-template-columns: 1fr; }
  .glass-card.builder-panel--split { grid-template-columns: 1fr; }
  .split-block + .split-block { border-left: none; border-top: 1px solid var(--color-border); }
  .team-card__main { flex-direction: column; align-items: stretch; }
  .section-actions--compact { justify-content: flex-start; }
}
@media (max-width: 640px) {
  .team-list { grid-template-columns: 1fr; }
  .builder-panel, .team-card, .board-column, .plan-preview { padding: var(--spacing-md); }
}
</style>
