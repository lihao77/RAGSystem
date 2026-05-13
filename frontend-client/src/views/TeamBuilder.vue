<template>
  <PageLayout
    title="Team 编排"
    subtitle="用可视化装配的方式组合 Agent 配置方案，切换后再进入配置页继续细调。"
    mobile-title="Team 编排"
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    max-width="1280px"
    content-padding="var(--spacing-lg)"
    mobile-content-padding="var(--spacing-sm)"
  >
    <template #header-actions>
      <div class="team-builder-header-spacer" aria-hidden="true"></div>
    </template>

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
        <section class="summary-grid adm-kpi-grid">
          <article class="summary-card adm-kpi-card summary-card--accent">
            <div class="summary-icon adm-kpi-icon summary-icon--active">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
            </div>
            <div class="summary-body adm-kpi-body">
              <span class="summary-label adm-kpi-label">当前 Team</span>
              <strong class="summary-value adm-kpi-value summary-value--active">{{ activeTeam || '未选择' }}</strong>
            </div>
          </article>

          <article class="summary-card adm-kpi-card">
            <div class="summary-icon adm-kpi-icon summary-icon--total">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="14" y="15" width="7" height="7" rx="1"/>
              </svg>
            </div>
            <div class="summary-body adm-kpi-body">
              <span class="summary-label adm-kpi-label">Team 总数</span>
              <strong class="summary-value adm-kpi-value">{{ teams.length }}</strong>
            </div>
          </article>

          <article class="summary-card adm-kpi-card">
            <div class="summary-icon adm-kpi-icon summary-icon--agents">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6"/><path d="M23 11h-6"/>
              </svg>
            </div>
            <div class="summary-body adm-kpi-body">
              <span class="summary-label adm-kpi-label">当前 Agent 数</span>
              <strong class="summary-value adm-kpi-value">{{ activeTeamInfo?.agent_count || 0 }}</strong>
            </div>
          </article>

          <article class="summary-card adm-kpi-card">
            <div class="summary-icon adm-kpi-icon summary-icon--file">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <div class="summary-body adm-kpi-body">
              <span class="summary-label adm-kpi-label">配置文件</span>
              <strong class="summary-value adm-kpi-value summary-value--mono">{{ activeTeamInfo?.file_path || '—' }}</strong>
            </div>
          </article>
        </section>

        <section class="panel-grid panel-grid--primary">
          <article class="glass-card builder-panel">
            <div class="section-toolbar">
              <div>
                <h2 class="section-title">切换生效 Team</h2>
                <p class="section-desc">切换后，Agent 配置页会直接编辑当前 Team 对应的配置文件。</p>
              </div>
            </div>
            <div class="builder-panel__body builder-panel__body--compact">
              <label class="form-item form-item--wide">
                <span class="field-label-text">Active Team</span>
                <CustomSelect
                  :model-value="activeTeam"
                  :options="teamOptions"
                  placeholder="选择 Team"
                  @update:model-value="handleActivateTeam"
                />
              </label>
              <div class="inline-actions inline-actions--wrap">
                <UiButton variant="primary" :disabled="working || !activeTeam" @click="goToAgentConfig">
                  前往当前 Team 配置页
                </UiButton>
              </div>
            </div>
          </article>

          <article class="glass-card builder-panel">
            <div class="section-toolbar">
              <div>
                <h2 class="section-title">创建新方案</h2>
                <p class="section-desc">可空白创建，也可基于已有 Team 整体复制一份。</p>
              </div>
            </div>
            <div class="builder-panel__body">
              <div class="form-grid">
                <label class="form-item">
                  <span class="field-label-text">新 Team 名称</span>
                  <input v-model.trim="newTeamName" type="text" class="form-control" placeholder="例如 research_v2" />
                </label>
                <label class="form-item">
                  <span class="field-label-text">复制来源</span>
                  <CustomSelect
                    :model-value="sourceTeam"
                    :options="[{ value: '', label: '空白创建' }, ...teamOptions]"
                    placeholder="选择来源 Team"
                    @update:model-value="sourceTeam = $event"
                  />
                </label>
              </div>
              <div class="section-actions">
                <UiButton variant="primary" :disabled="working" @click="handleCreateTeam">创建 Team</UiButton>
              </div>
            </div>
          </article>
        </section>

        <section class="glass-card builder-panel">
          <div class="section-toolbar">
            <div>
              <h2 class="section-title">可视化装配台</h2>
              <p class="section-desc">从来源 Team 选择 Agent，右侧预览目标 Team 当前内容，再将选中项增量复制过去。</p>
            </div>
          </div>

          <div class="composition-toolbar">
            <div class="form-grid form-grid--triple">
              <label class="form-item">
                <span class="field-label-text">来源 Team</span>
                <CustomSelect
                  :model-value="copySourceTeam"
                  :options="teamOptions"
                  placeholder="选择来源 Team"
                  @update:model-value="handleCopySourceChange"
                />
              </label>
              <label class="form-item">
                <span class="field-label-text">目标 Team</span>
                <CustomSelect
                  :model-value="copyTargetTeam"
                  :options="teamOptions"
                  placeholder="选择目标 Team"
                  @update:model-value="copyTargetTeam = $event"
                />
              </label>
              <div class="form-item">
                <span class="field-label-text">当前选择</span>
                <div class="selection-overview">
                  <span class="selection-stat">已选 {{ selectedCopyAgents.length }} 个</span>
                  <button class="selection-clear-btn" :disabled="selectedCopyAgents.length === 0" @click="clearSelectedAgents">
                    清空选择
                  </button>
                </div>
              </div>
            </div>
            <div class="inline-actions inline-actions--wrap composition-actions">
              <UiButton variant="ghost" :disabled="availableSourceAgents.length === 0" @click="selectAllAvailableAgents">
                全选可新增 Agent
              </UiButton>
              <UiButton variant="ghost" :disabled="copySourceAgents.length === 0" @click="selectAllSourceAgents">
                全选来源 Agent
              </UiButton>
              <span class="selection-hint">可新增 {{ availableSourceAgents.length }} 个，已存在 {{ conflictingSelectedAgents.length }} 个</span>
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
                  :class="{
                    'agent-card--selected': selectedCopyAgents.includes(agent),
                    'agent-card--conflict': targetAgentSet.has(agent) && copySourceTeam !== copyTargetTeam,
                    'agent-card--fresh': !targetAgentSet.has(agent) || copySourceTeam === copyTargetTeam,
                  }"
                  @click="toggleCopyAgent(agent)"
                >
                  <span class="agent-card__status" :class="{ 'agent-card__status--selected': selectedCopyAgents.includes(agent) }"></span>
                  <div class="agent-card__content">
                    <strong>{{ agent }}</strong>
                    <span>
                      {{ selectedCopyAgents.includes(agent)
                        ? (targetAgentSet.has(agent) && copySourceTeam !== copyTargetTeam ? '目标 Team 已存在，复制后保持去重结果' : '将作为新增 Agent 写入目标 Team')
                        : (targetAgentSet.has(agent) && copySourceTeam !== copyTargetTeam ? '目标 Team 已存在同名 Agent' : '点击加入复制队列') }}
                    </span>
                  </div>
                  <span class="agent-card__action">{{ targetAgentSet.has(agent) && copySourceTeam !== copyTargetTeam ? '已存在' : (selectedCopyAgents.includes(agent) ? '已选择' : '选择') }}</span>
                </button>
              </div>
              <div v-else class="empty-inline">当前来源 Team 暂无可复制的 Agent</div>
            </article>

            <article class="board-transfer">
              <div class="transfer-stack">
                <div class="transfer-badge">{{ selectedCopyAgents.length }} / {{ copySourceAgents.length }}</div>
                <UiButton class="transfer-button" variant="primary" :disabled="working" @click="handleCopyAgents">
                  复制到目标 Team
                </UiButton>
                <p class="transfer-hint">这是增量复制，不会覆盖目标 Team 已有的其他 Agent。</p>
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

              <div v-if="copyTargetAgents.length" class="agent-target-list">
                <div v-for="agent in copyTargetAgents" :key="`target-${agent}`" class="target-chip" :class="{ 'target-chip--incoming': selectedCopyAgents.includes(agent) && copySourceTeam !== copyTargetTeam }">
                  <span class="target-chip__dot"></span>
                  <span class="target-chip__text">{{ agent }}</span>
                  <span v-if="selectedCopyAgents.includes(agent) && copySourceTeam !== copyTargetTeam" class="target-chip__hint">已存在</span>
                </div>
              </div>
              <div v-else class="empty-inline">当前目标 Team 还没有 Agent，可直接从左侧装配</div>
            </article>
          </div>

          <div class="plan-preview">
            <div class="plan-preview__head">
              <div>
                <div class="board-caption">复制预览</div>
                <h3>即将写入 {{ copyTargetTeam || '目标 Team' }}</h3>
              </div>
              <span class="board-metric">{{ selectedCopyAgents.length }} 个待复制</span>
            </div>
            <div class="preview-stats">
              <div class="preview-stat-card">
                <span class="preview-stat-card__label">预计新增</span>
                <strong>{{ incomingSelectedAgents.length }}</strong>
              </div>
              <div class="preview-stat-card">
                <span class="preview-stat-card__label">已存在</span>
                <strong>{{ conflictingSelectedAgents.length }}</strong>
              </div>
              <div class="preview-stat-card">
                <span class="preview-stat-card__label">复制后目标总数</span>
                <strong>{{ projectedTargetAgentCount }}</strong>
              </div>
            </div>
            <div v-if="selectedCopyAgents.length" class="agent-chip-list">
              <span v-for="agent in selectedCopyAgents" :key="`preview-${agent}`" class="agent-chip" :class="targetAgentSet.has(agent) && copySourceTeam !== copyTargetTeam ? 'agent-chip--warning' : 'agent-chip--active'">
                <span class="agent-chip__dot"></span>
                {{ agent }}
              </span>
            </div>
            <div v-else class="empty-inline empty-inline--compact">先从左侧选择 Agent，这里会实时显示待复制清单。</div>
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
              <div class="team-card__head">
                <div class="team-card__identity">
                  <div class="team-card__title-row">
                    <h3>{{ team.team_name }}</h3>
                    <UiBadge class="team-badge" size="sm" :tone="team.is_active ? 'success' : 'neutral'">
                      {{ team.is_active ? '当前生效' : `${team.agent_count} Agents` }}
                    </UiBadge>
                  </div>
                  <p>{{ team.file_path }}</p>
                </div>
              </div>

              <div class="team-card__agents">
                <span v-for="agent in team.agents" :key="`${team.team_name}-${agent}`" class="team-agent-tag adm-chip" :title="agent">{{ agentDisplayMap[agent] || agent }}</span>
              </div>

              <div class="section-actions section-actions--compact adm-action-row">
                <button class="adm-action-btn adm-action-btn--success" :disabled="working || team.is_active" @click="handleActivateTeam(team.team_name)">激活</button>
                <button class="adm-action-btn" @click="openTeamConfig(team.team_name)">细调配置</button>
                <button v-if="team.team_name === 'default'" class="adm-action-btn adm-action-btn--warning" :disabled="working" @click="handleResetDefaultTeam">恢复默认</button>
                <button class="adm-action-btn adm-action-btn--danger" :disabled="working || team.is_active || teams.length <= 1" @click="handleDeleteTeam(team.team_name)">删除</button>
              </div>
            </article>
          </div>
        </EntityListLayout>
      </template>
    </div>
    <AppToast ref="toastRef" />
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageLayout from '../components/PageLayout.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import CustomSelect from '../components/CustomSelect.vue';
import AppToast from '../components/AppToast.vue';
import { UiBadge, UiButton } from '../components/ui';
import { activateTeam, copyAgentsToTeam, createTeam, deleteTeam, getAllAgentConfigs, getTeams, resetDefaultTeam } from '../api/agentConfig';

const props = defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const router = useRouter();
const loading = ref(false);
const working = ref(false);
const error = ref('');
const toastRef = ref(null);
const activeTeam = ref('');
const teams = ref([]);
const agentDisplayMap = ref({});
const newTeamName = ref('');
const sourceTeam = ref('');
const copySourceTeam = ref('');
const copyTargetTeam = ref('');
const selectedCopyAgents = ref([]);

const teamOptions = computed(() => teams.value.map(team => ({ value: team.team_name, label: team.team_name })));
const activeTeamInfo = computed(() => teams.value.find(team => team.team_name === activeTeam.value) || null);
const copySourceInfo = computed(() => teams.value.find(team => team.team_name === copySourceTeam.value) || null);
const copyTargetInfo = computed(() => teams.value.find(team => team.team_name === copyTargetTeam.value) || null);
const copySourceAgents = computed(() => copySourceInfo.value?.agents || []);
const copyTargetAgents = computed(() => copyTargetInfo.value?.agents || []);
const targetAgentSet = computed(() => new Set(copyTargetAgents.value));
const incomingSelectedAgents = computed(() => selectedCopyAgents.value.filter(agent => !targetAgentSet.value.has(agent) || copySourceTeam.value === copyTargetTeam.value));
const conflictingSelectedAgents = computed(() => selectedCopyAgents.value.filter(agent => targetAgentSet.value.has(agent) && copySourceTeam.value !== copyTargetTeam.value));
const availableSourceAgents = computed(() => copySourceAgents.value.filter(agent => !targetAgentSet.value.has(agent) || copySourceTeam.value === copyTargetTeam.value));
const projectedTargetAgentCount = computed(() => copyTargetAgents.value.length + incomingSelectedAgents.value.filter(agent => !copyTargetAgents.value.includes(agent)).length);

function showToast(message, type = 'error') {
  toastRef.value?.show(message, type);
}

function normalizeSelections() {
  selectedCopyAgents.value = selectedCopyAgents.value.filter(agent => copySourceAgents.value.includes(agent));
}

async function loadTeams() {
  loading.value = true;
  error.value = '';
  try {
    const result = await getTeams();
    activeTeam.value = result.active_team || '';
    teams.value = Array.isArray(result.teams) ? result.teams : [];
    const configs = await getAllAgentConfigs().catch(() => ({}))
    agentDisplayMap.value = Object.fromEntries(
      Object.entries(configs || {}).map(([name, cfg]) => [name, cfg?.display_name || name])
    )
    if (!copySourceTeam.value && teams.value.length > 0) {
      copySourceTeam.value = teams.value[0].team_name;
    }
    if (!copyTargetTeam.value && activeTeam.value) {
      copyTargetTeam.value = activeTeam.value;
    }
    normalizeSelections();
  } catch (err) {
    error.value = err.message || '加载 Team 列表失败';
  } finally {
    loading.value = false;
  }
}

async function refreshTeams() {
  await loadTeams();
  showToast('已刷新 Team 列表', 'success');
}

async function handleCreateTeam() {
  if (!newTeamName.value) {
    showToast('请输入新的 Team 名称');
    return;
  }
  working.value = true;
  try {
    const result = await createTeam({
      team_name: newTeamName.value,
      source_team: sourceTeam.value || undefined,
    });
    activeTeam.value = result.active_team || activeTeam.value;
    teams.value = Array.isArray(result.teams) ? result.teams : teams.value;
    copyTargetTeam.value = newTeamName.value;
    newTeamName.value = '';
    showToast('Team 创建成功', 'success');
  } catch (err) {
    showToast(err.message || '创建 Team 失败');
  } finally {
    working.value = false;
  }
}

async function handleActivateTeam(teamName) {
  if (!teamName || teamName === activeTeam.value) return;
  working.value = true;
  try {
    const result = await activateTeam(teamName);
    activeTeam.value = result.active_team || teamName;
    teams.value = Array.isArray(result.teams) ? result.teams : teams.value;
    copyTargetTeam.value = activeTeam.value;
    showToast(`已切换到 Team：${teamName}`, 'success');
  } catch (err) {
    showToast(err.message || '切换 Team 失败');
  } finally {
    working.value = false;
  }
}

function handleCopySourceChange(teamName) {
  copySourceTeam.value = teamName;
  selectedCopyAgents.value = [];
}

function toggleCopyAgent(agentName) {
  if (selectedCopyAgents.value.includes(agentName)) {
    selectedCopyAgents.value = selectedCopyAgents.value.filter(item => item !== agentName);
    return;
  }
  selectedCopyAgents.value = [...selectedCopyAgents.value, agentName];
}

function clearSelectedAgents() {
  selectedCopyAgents.value = [];
}

function selectAllSourceAgents() {
  selectedCopyAgents.value = [...copySourceAgents.value];
}

function selectAllAvailableAgents() {
  selectedCopyAgents.value = [...availableSourceAgents.value];
}

async function handleCopyAgents() {
  if (!copySourceTeam.value || !copyTargetTeam.value) {
    showToast('请选择来源 Team 和目标 Team');
    return;
  }
  if (selectedCopyAgents.value.length === 0) {
    showToast('请选择至少一个 Agent');
    return;
  }
  working.value = true;
  try {
    const result = await copyAgentsToTeam(copyTargetTeam.value, copySourceTeam.value, selectedCopyAgents.value);
    teams.value = Array.isArray(result.teams) ? result.teams : teams.value;
    const copiedCount = incomingSelectedAgents.value.length;
    const skippedCount = conflictingSelectedAgents.value.length;
    selectedCopyAgents.value = [];
    showToast(skippedCount > 0 ? `复制完成：新增 ${copiedCount} 个，已存在 ${skippedCount} 个` : `复制完成：新增 ${copiedCount} 个 Agent`, 'success');
  } catch (err) {
    showToast(err.message || '复制 Agent 失败');
  } finally {
    working.value = false;
  }
}

async function handleDeleteTeam(teamName) {
  working.value = true;
  try {
    const result = await deleteTeam(teamName);
    activeTeam.value = result.active_team || activeTeam.value;
    teams.value = Array.isArray(result.teams) ? result.teams : teams.value;
    if (copyTargetTeam.value === teamName) {
      copyTargetTeam.value = activeTeam.value;
    }
    if (copySourceTeam.value === teamName) {
      copySourceTeam.value = teams.value[0]?.team_name || '';
      selectedCopyAgents.value = [];
    }
    showToast('Team 删除成功', 'success');
  } catch (err) {
    showToast(err.message || '删除 Team 失败');
  } finally {
    working.value = false;
  }
}

async function handleResetDefaultTeam() {
  working.value = true;
  try {
    await resetDefaultTeam();
    await loadTeams();
    showToast('default team 已重置为系统默认配置', 'success');
  } catch (err) {
    showToast(err.message || '重置 default team 失败');
  } finally {
    working.value = false;
  }
}

function goToAgentConfig() {
  router.push('/agent-config');
}

async function openTeamConfig(teamName) {
  if (teamName && teamName !== activeTeam.value) {
    await handleActivateTeam(teamName);
  }
  router.push('/agent-config');
}

onMounted(() => {
  loadTeams();
});
</script>

<style scoped>
.team-builder-page {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.team-builder-header-spacer {
  width: 96px;
  min-width: 96px;
  height: 36px;
  pointer-events: none;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.summary-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid var(--adm-border);
  background: var(--adm-surface-raised);
  box-shadow: var(--adm-shadow-inset);
}

.summary-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  background: var(--adm-control-bg);
  border: 1px solid var(--adm-border);
}

.summary-icon--active,
.summary-icon--total,
.summary-icon--agents,
.summary-icon--file {
  color: var(--color-text-secondary);
  background: var(--adm-control-bg);
  border-color: var(--adm-border);
}

.summary-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.field-label-text,
.board-caption {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
}

.summary-label {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  letter-spacing: 0;
  line-height: 1.2;
  text-transform: none;
  white-space: nowrap;
}

.summary-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text-primary);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary-value--active {
  color: var(--color-text-primary);
}

.summary-value--mono {
  font-size: 13px;
  font-family: 'Consolas', 'SFMono-Regular', monospace;
  word-break: break-all;
}

.panel-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.builder-panel {
  position: relative;
  overflow: visible;
  padding: 20px;
  border-radius: 20px;
}

.builder-panel__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.builder-panel__body--compact {
  margin-top: 10px;
}

.section-toolbar,
.section-actions,
.inline-actions,
.selection-overview {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.inline-actions--wrap {
  justify-content: flex-start;
}

.section-toolbar {
  margin-bottom: 16px;
}

.section-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text-primary);
}

.section-desc {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.form-grid--triple {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.form-item {
  position: relative;
  z-index: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-item:focus-within {
  z-index: 30;
}

.form-item--wide {
  width: min(420px, 100%);
}

.form-control {
  width: 100%;
  min-height: 44px;
  border-radius: 14px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  padding: 0 14px;
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}

.form-control:focus {
  outline: none;
  border-color: rgba(99, 102, 241, 0.52);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12);
}

.selection-overview {
  min-height: 44px;
  padding: 0 14px;
  border-radius: 14px;
  border: 1px solid var(--color-border);
  background: var(--color-hover-overlay);
}

.selection-clear-btn {
  border: none;
  background: transparent;
  padding: 0;
  color: rgba(191, 219, 254, 0.92);
  font-size: 12px;
  cursor: pointer;
}

.selection-clear-btn:disabled {
  color: rgba(226, 232, 240, 0.34);
  cursor: default;
}

.selection-stat,
.board-metric,
.selection-hint {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.composition-actions {
  margin-top: 12px;
}

.composition-toolbar {
  position: relative;
  z-index: 20;
  margin-bottom: 18px;
}

.composition-board {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 168px minmax(0, 1fr);
  gap: 16px;
  align-items: stretch;
}

.board-column,
.plan-preview {
  padding: 18px;
  border-radius: 18px;
  border: 1px solid var(--color-border);
  background: var(--color-hover-overlay);
}

.board-column__head,
.plan-preview__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}

.board-column__head h3,
.plan-preview__head h3 {
  margin: 6px 0 0;
  font-size: 18px;
  color: var(--color-text-primary);
}

.agent-card-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.agent-card {
  width: 100%;
  padding: 14px 16px;
  border-radius: 16px;
  border: 1px solid var(--color-border);
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.agent-card:hover {
  border-color: rgba(148, 163, 184, 0.32);
}

.agent-card--selected {
  border-color: rgba(96, 165, 250, 0.42);
  background: rgba(59, 130, 246, 0.12);
}

.agent-card--conflict {
  border-color: rgba(245, 158, 11, 0.22);
  background: rgba(245, 158, 11, 0.06);
}

.agent-card--fresh {
  border-color: rgba(16, 185, 129, 0.16);
}

.agent-card__status {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.72);
}

.agent-card__status--selected {
  background: var(--color-brand-accent-light);
}

.agent-card__content {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.agent-card__content strong {
  font-size: 14px;
  color: var(--color-text-primary);
}

.agent-card__content span,
.target-chip__hint,
.transfer-hint {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.agent-card__action {
  font-size: 12px;
  color: var(--color-brand-accent-light);
  white-space: nowrap;
}

.board-transfer {
  display: flex;
  align-items: center;
  justify-content: center;
}

.transfer-stack {
  width: 100%;
  height: 100%;
  min-height: 220px;
  border-radius: 12px;
  border: 1px dashed var(--color-border);
  background: var(--color-hover-overlay);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 20px;
  text-align: center;
}

.transfer-badge {
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--adm-border);
  background: var(--adm-control-bg);
  color: var(--color-text-secondary);
  font-size: 12px;
}

.transfer-button {
  width: 100%;
}

.agent-target-list,
.team-card__agents,
.agent-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.target-chip,
.team-agent-tag,
.agent-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
  font-size: 12px;
}

.team-agent-tag {
  max-width: 100%;
  padding: 4px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.target-chip--incoming {
  border-color: rgba(245, 158, 11, 0.28);
  background: rgba(245, 158, 11, 0.08);
}

.target-chip__dot,
.agent-chip__dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.72);
}

.agent-chip--active {
  background: rgba(59, 130, 246, 0.12);
  border-color: rgba(96, 165, 250, 0.38);
}

.agent-chip--warning {
  background: rgba(245, 158, 11, 0.08);
  border-color: rgba(245, 158, 11, 0.28);
}

.agent-chip--active .agent-chip__dot,
.agent-chip--warning .agent-chip__dot {
  background: var(--color-brand-accent-light);
}

.plan-preview {
  margin-top: 16px;
}

.preview-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}

.preview-stat-card {
  padding: 14px;
  border-radius: 14px;
  border: 1px solid var(--color-border);
  background: var(--color-hover-overlay);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.preview-stat-card__label {
  font-size: 12px;
  color: rgba(226, 232, 240, 0.66);
}

.preview-stat-card strong {
  font-size: 18px;
  color: var(--color-text-primary);
}

.empty-inline {
  padding: 18px 14px;
  border-radius: 14px;
  background: var(--color-hover-overlay);
  color: var(--color-text-secondary);
  text-align: center;
  font-size: 13px;
}

.empty-inline--compact {
  padding-block: 14px;
}

.team-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.team-card {
  display: grid;
  grid-template-columns: minmax(220px, 1.1fr) minmax(180px, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border-radius: 10px;
  transition: border-color 0.18s ease;
}

.team-card--active {
  border-color: rgba(99, 102, 241, 0.3);
}

.team-card__identity {
  min-width: 0;
}

.team-card__title-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.team-card__title-row h3 {
  margin: 0;
  font-size: 16px;
  line-height: 1.25;
  color: var(--color-text-primary);
}

.team-card__identity p {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--color-text-secondary);
  word-break: break-all;
}

.team-badge {
  flex: 0 0 auto;
  white-space: nowrap;
}

.section-actions--compact {
  justify-content: flex-end;
}

@media (max-width: 1100px) {
  .composition-board {
    grid-template-columns: 1fr;
  }

  .board-transfer {
    order: 2;
  }

  .board-column--target {
    order: 3;
  }
}

@media (max-width: 960px) {
  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .panel-grid,
  .form-grid,
  .form-grid--triple {
    grid-template-columns: 1fr;
  }

  .team-card {
    grid-template-columns: 1fr;
    align-items: stretch;
  }
}

@media (max-width: 640px) {
  .summary-grid,
  .team-list {
    grid-template-columns: 1fr;
  }

  .summary-card,
  .builder-panel,
  .team-card,
  .board-column,
  .plan-preview {
    padding: 16px;
  }

  .summary-value {
    font-size: 18px;
  }
}
</style>
