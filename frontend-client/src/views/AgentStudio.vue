<template>
  <PageLayout
    title="Agent 编排"
    subtitle="Team 与 Agent 配置"
    mobile-title="Agent 编排"
    fill
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
  >
    <template #header-actions>
      <span class="run-default-pill" title="当前对话实际运行的 Team">
        <span class="run-default-pill__dot"></span>运行时默认：<strong>{{ activeTeam || '—' }}</strong>
      </span>
      <Button variant="outline" size="sm" :disabled="loading" @click="loadAll(true)">
        <RefreshCw data-icon="inline-start" :class="{ 'animate-spin': loading }" />
        刷新
      </Button>
    </template>

    <div class="studio-workbench">
      <!-- 左：导航树 Card -->
      <Card class="studio-nav-card">
        <CardHeader class="studio-nav__head">
          <CardTitle class="studio-nav__title">Team / Agent</CardTitle>
          <Button variant="outline" size="icon-sm" title="新建 Team" aria-label="新建 Team" @click="createTeamDialogOpen = true">
            <Plus data-icon="inline-start" />
          </Button>
        </CardHeader>

        <CardContent class="studio-nav__body">
          <div v-if="loading" class="navigator-state">
            <Spinner />
            <span>加载中</span>
          </div>
          <div v-else-if="error" class="navigator-state navigator-state--error" role="alert">
            <strong>加载失败</strong>
            <span>{{ error }}</span>
            <Button variant="outline" size="sm" @click="loadAll(true)">重试</Button>
          </div>
          <Empty v-else-if="!teams.length" class="navigator-empty">
            <EmptyHeader><EmptyTitle>暂无 Team</EmptyTitle></EmptyHeader>
          </Empty>

          <template v-else>
            <div v-for="team in teams" :key="team.team_name" class="navigator-group">
              <div
                class="navigator-group__label"
                :class="{ 'navigator-group__label--collapsible': team.team_name !== BUILDER_TEAM }"
                @click="toggleTeamCollapse(team.team_name)"
              >
                <ChevronDown
                  v-if="team.team_name !== BUILDER_TEAM"
                  class="navigator-group__caret"
                  :class="{ 'navigator-group__caret--collapsed': isTeamCollapsed(team.team_name) }"
                />
                <span class="navigator-group__name">{{ team.team_name === BUILDER_TEAM ? 'Agent Builder' : team.team_name }}</span>
                <Badge v-if="team.team_name === BUILDER_TEAM" variant="secondary">系统</Badge>
                <Badge v-else-if="team.team_name === activeTeam" variant="success">运行时</Badge>
                <span v-else class="navigator-group__count">{{ team.agents?.length || 0 }}</span>
                <DropdownMenu v-if="team.team_name !== BUILDER_TEAM">
                  <DropdownMenuTrigger as-child>
                    <button
                      type="button"
                      class="navigator-group__more"
                      title="团队操作"
                      aria-label="团队操作"
                      :disabled="teamBusy"
                      @click.stop
                    ><MoreHorizontal :size="15" /></button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" :side-offset="4" class="min-w-[160px]">
                    <DropdownMenuItem
                      v-if="team.team_name !== activeTeam"
                      @click="handleActivateTeam(team.team_name)"
                    >设为运行时默认</DropdownMenuItem>
                    <DropdownMenuItem
                      v-if="team.team_name === 'default'"
                      @click="handleResetDefault"
                    >恢复默认配置</DropdownMenuItem>
                    <DropdownMenuSeparator v-if="team.team_name !== activeTeam || team.team_name === 'default'" />
                    <DropdownMenuItem
                      class="navigator-group__menu-danger"
                      :disabled="team.team_name === activeTeam || teams.length <= 1"
                      @click="handleDeleteTeam(team.team_name)"
                    >删除 Team</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <template v-if="team.team_name === BUILDER_TEAM">
                <div class="navigator-row navigator-row--static">
                  <p>通过调研、设计、评估和调优生成业务 Team</p>
                </div>
              </template>
              <template v-else>
                <div v-show="!isTeamCollapsed(team.team_name)" class="navigator-group__agents">
                  <button
                    v-for="agent in team.agents || []"
                    :key="`${team.team_name}-${agent}`"
                    type="button"
                    :class="['navigator-row', { 'navigator-row--active': selectedTeam === team.team_name && selectedAgent === agent }]"
                    @click="onSelectAgent(team.team_name, agent)"
                  >
                    <div class="navigator-row__title">
                      <span class="navigator-row__name">{{ displayMap[agent] || agent }}</span>
                      <span v-if="isEntryAgent(team.team_name, agent)" class="navigator-row__entry">入口</span>
                    </div>
                    <p v-if="displayMap[agent] && displayMap[agent] !== agent">{{ agent }}</p>
                  </button>
                  <button type="button" class="navigator-row navigator-row--add" @click="openCreateAgent(team.team_name)">
                    <Plus :size="13" />
                    <span>新建 Agent</span>
                  </button>
                </div>
              </template>
            </div>
          </template>
        </CardContent>
      </Card>

      <!-- 右：配置工作区 Card -->
      <Card class="studio-panel-card">
        <main class="studio-panel">
          <div v-if="detailLoading" class="workspace-state">
            <Spinner />
            <span>加载 Agent 配置</span>
          </div>
          <Empty v-else-if="!selectedAgent" class="workspace-state">
            <EmptyHeader><EmptyTitle>选择一个 Agent</EmptyTitle></EmptyHeader>
          </Empty>

          <template v-else>
            <header class="workspace-header">
              <div class="workspace-header__identity">
                <div class="workspace-header__title-row">
                  <h2>{{ displayMap[selectedAgent] || selectedAgent }}</h2>
                  <Badge variant="outline">{{ selectedTeam }}</Badge>
                </div>
                <p>{{ form.description || selectedAgent }}</p>
              </div>
              <div class="workspace-header__actions">
                <Button variant="ghost" size="icon-sm" title="导出配置" aria-label="导出配置" @click="handleExport">
                  <Download data-icon="inline-start" />
                </Button>
                <Button variant="ghost" size="icon-sm" title="删除 Agent" aria-label="删除 Agent" @click="handleDeleteAgent">
                  <Trash2 data-icon="inline-start" />
                </Button>
              </div>
            </header>

            <div class="workspace-tabbar">
              <Tabs :model-value="activeTab" class="workspace-tabs" @update:model-value="handleTabChange">
                <TabsList>
                  <TabsTrigger value="config" class="workspace-tab">
                    配置<span v-if="dirty.config" class="workspace-tab__dot" />
                  </TabsTrigger>
                  <TabsTrigger v-if="pluginAvailability.skills" value="skills" class="workspace-tab">
                    技能<span v-if="dirty.skills" class="workspace-tab__dot" />
                  </TabsTrigger>
                  <TabsTrigger v-if="pluginAvailability.memory" value="memory" class="workspace-tab">
                    记忆<span v-if="dirty.memory" class="workspace-tab__dot" />
                  </TabsTrigger>
                  <TabsTrigger v-if="pluginAvailability.mcp" value="mcp" class="workspace-tab">
                    MCP<span v-if="dirty.mcp" class="workspace-tab__dot" />
                  </TabsTrigger>
                  <TabsTrigger v-if="pluginAvailability.knowledge" value="knowledge" class="workspace-tab">
                    知识库<span v-if="dirty.knowledge" class="workspace-tab__dot" />
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            <div class="workspace-body">
              <div v-show="activeTab === 'config'" class="workspace-pane">
                <MainConfigForm
                  :form="form"
                  :agent-name="selectedAgent"
                  :tools="tools"
                  :peer-agents="peerAgents"
                  :display-map="displayMap"
                  :provider-options="providerOptions"
                  :get-tier-provider-key="getTierProviderKey"
                  :get-tier-model-options="getTierModelOptions"
                  :handle-tier-provider-change="handleTierProviderChange"
                />
              </div>
              <div v-show="activeTab === 'skills'" class="workspace-pane">
                <SkillsPanel :form="form" :skills="skills" />
              </div>
              <div v-show="activeTab === 'memory'" class="workspace-pane">
                <MemoryPanel :form="form" :scope-meta="memoryScopeMeta" />
              </div>
              <div v-show="activeTab === 'mcp'" class="workspace-pane">
                <McpPanel :form="form" :servers="mcpServers" />
              </div>
              <div v-show="activeTab === 'knowledge'" class="workspace-pane">
                <KnowledgePanel :form="form" />
              </div>
            </div>

            <div class="workspace-savebar">
              <span v-if="dirty[activeTab]" class="workspace-savebar__state workspace-savebar__state--dirty">● 本页有未保存修改</span>
              <span v-else class="workspace-savebar__state workspace-savebar__state--saved">✓ 已保存</span>
              <span class="workspace-savebar__spacer"></span>
              <Button variant="outline" size="sm" :disabled="!dirty[activeTab] || saving" @click="resetTab(activeTab)">放弃</Button>
              <Button size="sm" :disabled="!dirty[activeTab] || saving" @click="handleSave(activeTab)">
                <Spinner v-if="saving" data-icon="inline-start" />
                <Save v-else data-icon="inline-start" />
                保存
              </Button>
            </div>
          </template>
        </main>
      </Card>
    </div>

    <!-- 新建 Team -->
    <Dialog :open="createTeamDialogOpen" @update:open="(v) => { if (!v) createTeamDialogOpen = false }">
      <DialogContent class="max-w-[440px]">
        <DialogHeader>
          <DialogTitle>新建 Team</DialogTitle>
          <DialogDescription>可基于现有 Team 复制，或创建空白 Team。</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel for="new-team-name">名称</FieldLabel>
            <Input id="new-team-name" v-model.trim="createTeamForm.teamName" placeholder="仅限英文、数字、下划线" />
          </Field>
          <Field>
            <FieldLabel for="new-team-source">复制自</FieldLabel>
            <select id="new-team-source" v-model="createTeamForm.sourceTeam" class="form-control">
              <option value="">空白 Team</option>
              <option v-for="t in teams.filter(x => x.team_name !== BUILDER_TEAM)" :key="t.team_name" :value="t.team_name">{{ t.team_name }}</option>
            </select>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="ghost" :disabled="teamBusy" @click="createTeamDialogOpen = false">取消</Button>
          <Button :disabled="teamBusy || !createTeamForm.teamName" @click="handleCreateTeam">
            <Spinner v-if="teamBusy" data-icon="inline-start" />
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 新建 Agent -->
    <Dialog :open="createVisible" @update:open="(v) => { if (!v) createVisible = false }">
      <DialogContent class="max-w-[480px]">
        <DialogHeader><DialogTitle>在「{{ selectedTeam }}」新建 Agent</DialogTitle></DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel for="new-agent-name">Agent 名称</FieldLabel>
            <Input id="new-agent-name" v-model.trim="createAgentForm.agentName" placeholder="仅限英文、数字和下划线" />
          </Field>
          <Field>
            <FieldLabel for="new-agent-display">显示名称</FieldLabel>
            <Input id="new-agent-display" v-model.trim="createAgentForm.displayName" placeholder="可选" />
          </Field>
          <Field>
            <FieldLabel for="new-agent-desc">描述</FieldLabel>
            <Input id="new-agent-desc" v-model.trim="createAgentForm.description" placeholder="可选" />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="ghost" :disabled="agentBusy" @click="createVisible = false">取消</Button>
          <Button :disabled="agentBusy || !createAgentForm.agentName" @click="handleCreateAgent">
            <Spinner v-if="agentBusy" data-icon="inline-start" />
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { ChevronDown, Download, MoreHorizontal, Plus, RefreshCw, Save, Trash2 } from 'lucide-vue-next';
import PageLayout from '../components/PageLayout.vue';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { Empty, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import MainConfigForm from '../components/agent-studio/MainConfigForm.vue';
import SkillsPanel from '../components/agent-studio/SkillsPanel.vue';
import MemoryPanel from '../components/agent-studio/MemoryPanel.vue';
import McpPanel from '../components/agent-studio/McpPanel.vue';
import KnowledgePanel from '../components/agent-studio/KnowledgePanel.vue';
import { useDictionariesStore } from '../stores/dictionaries.js';
import { useConfirm } from '../composables/useConfirm.js';
import { useToast } from '../composables/useToast.js';
import { showToast as showToastMessage } from '../utils/toast.js';
import {
  getAgentConfig,
  updateAgentConfig,
  createAgent,
  deleteAgent,
  getAvailableTools,
  getAvailableMCPServers,
  getMcpAgentConfig,
  updateMcpAgentConfig,
  exportAgentConfig,
  createTeam,
  activateTeam,
  deleteTeam,
  resetDefaultTeam,
} from '../api/agentConfig.js';
import { getAvailableSkills, getSkillsAgentConfig, updateSkillsAgentConfig } from '../api/skillLibrary.js';
import { getMemoryAgentConfig, updateMemoryAgentConfig, getMemoryConfigMetadata } from '../api/memory.js';
import { getKnowledgeAgentConfig, updateKnowledgeAgentConfig } from '../api/knowledgeBase.js';
import { applyProviderToLlm, getProviderModels } from '../utils/modelList.js';
import {
  applyConfigToForm,
  buildMainPayload,
  buildMemoryPluginConfig,
  buildKnowledgePluginConfig,
  buildSkillsPluginConfig,
  buildMcpPluginConfig,
  sanitizeAvailableTools,
  memoryScopeFallbackMeta,
} from '../components/agent-studio/agentFormModel.js';
import { useAgentForm } from '../components/agent-studio/useAgentForm.js';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const BUILDER_TEAM = 'agent-builder';

const dictStore = useDictionariesStore();
const { confirm } = useConfirm();
const toast = useToast();
const showToast = (message, type = 'error') => showToastMessage(toast, message, type);

const loading = ref(false);
const error = ref('');
const teams = ref([]);
const activeTeam = ref('');
const configsByTeam = reactive({});
const displayMap = ref({});

const selectedTeam = ref('');
const selectedAgent = ref('');

const detailLoading = ref(false);
const saving = ref(false);
const { form, rawConfig, dirty, activeTab, applyConfig, applyConfigInPlace, clearForm, resetTab } = useAgentForm();

const tools = ref([]);
const skills = ref([]);
const mcpServers = ref([]);
const providers = ref([]);
const memoryScopeMeta = ref(memoryScopeFallbackMeta);
const pluginAvailability = reactive({ skills: false, memory: false, mcp: false, knowledge: false });

const providerOptions = computed(() => [
  { value: '', label: '未设置' },
  ...providers.value.map((p) => ({ value: p.key || p.name, label: `${p.name}${p.provider_type ? ` (${p.provider_type})` : ''}` })),
]);
const peerAgents = computed(() => Object.keys(configsByTeam[selectedTeam.value] || {}).filter((a) => a !== selectedAgent.value));

const teamBusy = ref(false);
const agentBusy = ref(false);
const createTeamDialogOpen = ref(false);
const createTeamForm = reactive({ teamName: '', sourceTeam: '' });
const createVisible = ref(false);
const createAgentForm = reactive({ agentName: '', displayName: '', description: '' });

function isEntryAgent(teamName, agent) {
  return !!configsByTeam[teamName]?.[agent]?.default_entry;
}

/* Team 折叠：状态存内存，Builder 恒展开 */
const collapsedTeams = ref(new Set());
function isTeamCollapsed(teamName) {
  return collapsedTeams.value.has(teamName);
}
function toggleTeamCollapse(teamName) {
  if (teamName === BUILDER_TEAM) return;
  const next = new Set(collapsedTeams.value);
  if (next.has(teamName)) next.delete(teamName);
  else next.add(teamName);
  collapsedTeams.value = next;
}

async function loadAll(force = false) {
  loading.value = true;
  error.value = '';
  try {
    const summary = await dictStore.ensureTeams(force);
    teams.value = Array.isArray(summary.teams) ? summary.teams : [];
    activeTeam.value = summary.active_team || '';
    const entries = await Promise.all(
      teams.value
        .filter((t) => t.team_name !== BUILDER_TEAM)
        .map(async (t) => [t.team_name, await dictStore.ensureAgents(force, t.team_name).catch(() => ({}))])
    );
    for (const [team, configs] of entries) configsByTeam[team] = configs || {};
    const map = {};
    for (const configs of Object.values(configsByTeam)) {
      for (const [name, cfg] of Object.entries(configs || {})) map[name] = cfg?.display_name || name;
    }
    displayMap.value = map;

    if (!selectedTeam.value || !configsByTeam[selectedTeam.value]) {
      selectedTeam.value = configsByTeam[activeTeam.value]
        ? activeTeam.value
        : (teams.value.find((t) => t.team_name !== BUILDER_TEAM)?.team_name || '');
    }
    const teamAgents = Object.keys(configsByTeam[selectedTeam.value] || {});
    if (!selectedAgent.value || !teamAgents.includes(selectedAgent.value)) {
      selectedAgent.value = teamAgents[0] || '';
    }
    if (selectedAgent.value) await loadAgentDetail();
  } catch (err) {
    error.value = err?.message || '加载 Team / Agent 失败';
  } finally {
    loading.value = false;
  }
}

async function loadAgentDetail() {
  if (!selectedAgent.value || !selectedTeam.value) return;
  detailLoading.value = true;
  try {
    const [config, pluginConfigs] = await Promise.all([
      getAgentConfig(selectedAgent.value, selectedTeam.value),
      loadPluginConfigs(),
    ]);
    const { form: f, raw } = applyConfigToForm(config, pluginConfigs);
    await loadSupplementaryData(config?.custom_params?.workspace_root || '');
    applyConfig(f, raw);
  } catch (err) {
    showToast(err?.message || '加载 Agent 详情失败');
  } finally {
    detailLoading.value = false;
  }
}

async function loadPluginConfigs() {
  const team = selectedTeam.value;
  const name = selectedAgent.value;
  const [memory, knowledge, skill, mcp] = await Promise.allSettled([
    getMemoryAgentConfig(name, team),
    getKnowledgeAgentConfig(name, team),
    getSkillsAgentConfig(name, team),
    getMcpAgentConfig(name, team),
  ]);
  pluginAvailability.memory = memory.status === 'fulfilled';
  pluginAvailability.knowledge = knowledge.status === 'fulfilled';
  pluginAvailability.skills = skill.status === 'fulfilled';
  pluginAvailability.mcp = mcp.status === 'fulfilled';
  return {
    memory: memory.status === 'fulfilled' ? memory.value : null,
    knowledge: knowledge.status === 'fulfilled' ? knowledge.value : null,
    skills: skill.status === 'fulfilled' ? skill.value : null,
    mcp: mcp.status === 'fulfilled' ? mcp.value : null,
  };
}

async function loadSupplementaryData(workspaceRoot = '') {
  const [toolRes, skillRes, mcpRes, providerRes, memoryRes] = await Promise.allSettled([
    getAvailableTools(),
    getAvailableSkills(workspaceRoot),
    pluginAvailability.mcp ? getAvailableMCPServers() : Promise.resolve([]),
    dictStore.ensureProviders(),
    pluginAvailability.memory ? getMemoryConfigMetadata() : Promise.resolve({ scopes: [] }),
  ]);
  tools.value = toolRes.status === 'fulfilled' ? sanitizeAvailableTools(toolRes.value) : [];
  skills.value = skillRes.status === 'fulfilled' && Array.isArray(skillRes.value) ? skillRes.value : [];
  mcpServers.value = mcpRes.status === 'fulfilled' && Array.isArray(mcpRes.value) ? mcpRes.value : [];
  providers.value = providerRes.status === 'fulfilled' && Array.isArray(providerRes.value) ? providerRes.value : [];
  memoryScopeMeta.value = memoryRes.status === 'fulfilled' && Array.isArray(memoryRes.value?.scopes) && memoryRes.value.scopes.length
    ? memoryRes.value.scopes
    : memoryScopeFallbackMeta;
}

function hasAnyDirty() {
  return Object.values(dirty).some(Boolean);
}

/** 切 Agent 守卫：有未保存修改时先确认，确认则放弃改动并加载目标 Agent。 */
async function onSelectAgent(team, agent) {
  if (team === selectedTeam.value && agent === selectedAgent.value) return;
  if (hasAnyDirty()) {
    const accepted = await confirm({
      title: '放弃未保存的修改？',
      message: `「${displayMap.value[selectedAgent.value] || selectedAgent.value}」有未保存的修改，切换 Agent 将丢弃这些修改。`,
      confirmText: '放弃并切换',
      cancelText: '留下',
      danger: true,
    });
    if (!accepted) return;
  }
  selectedTeam.value = team;
  selectedAgent.value = agent;
  loadAgentDetail();
}

const TAB_LABELS = { config: '配置', skills: '技能', memory: '记忆', mcp: 'MCP', knowledge: '知识库' };

/** 切 tab 守卫：离开有未保存修改的页时先确认，避免改完忘存。确认后保留脏标记只换页。 */
async function handleTabChange(next) {
  const from = activeTab.value;
  if (next === from) return;
  if (!dirty[from]) { activeTab.value = next; return; }
  const accepted = await confirm({
    title: '有未保存的修改',
    message: `「${TAB_LABELS[from] || from}」页有未保存的修改，切换后仍保留，可随时回来保存。确认切换？`,
    confirmText: '切换',
    cancelText: '留下',
    danger: false,
  });
  if (accepted) activeTab.value = next;
}

async function handleSave(tab) {
  if (saving.value) return;
  if (tab === 'config') {
    if (!form.value.llm_tiers.default?.provider) { showToast('请选择默认 LLM 的 Provider'); return; }
    for (const tier of ['default', 'fast', 'powerful']) {
      const t = form.value.llm_tiers[tier];
      if (t && !t.provider) { showToast(`请选择 ${tier} 层级的 Provider，或禁用该层级`); return; }
    }
  }
  saving.value = true;
  try {
    const team = selectedTeam.value;
    const name = selectedAgent.value;
    if (tab === 'config') await updateAgentConfig(name, buildMainPayload(form.value, rawConfig.value, name), team);
    else if (tab === 'skills') await updateSkillsAgentConfig(name, buildSkillsPluginConfig(form.value), team);
    else if (tab === 'memory') await updateMemoryAgentConfig(name, buildMemoryPluginConfig(form.value), team);
    else if (tab === 'mcp') await updateMcpAgentConfig(name, buildMcpPluginConfig(form.value), team);
    else if (tab === 'knowledge') await updateKnowledgeAgentConfig(name, buildKnowledgePluginConfig(form.value), team);
    dictStore.invalidateAgents(team);
    await refreshAfterSave();
    showToast('保存成功', 'success');
  } catch (err) {
    showToast(err?.message || '保存配置失败');
  } finally {
    saving.value = false;
  }
}

async function refreshAfterSave() {
  const [config, pluginConfigs] = await Promise.all([
    getAgentConfig(selectedAgent.value, selectedTeam.value),
    loadPluginConfigs(),
  ]);
  const { form: f, raw } = applyConfigToForm(config, pluginConfigs);
  applyConfigInPlace(f, raw);
  displayMap.value = { ...displayMap.value, [selectedAgent.value]: f.display_name || selectedAgent.value };
}

function openCreateAgent(team) {
  if (team && team !== selectedTeam.value) selectedTeam.value = team;
  Object.assign(createAgentForm, { agentName: '', displayName: '', description: '' });
  createVisible.value = true;
}

async function handleCreateAgent() {
  const { agentName, displayName, description } = createAgentForm;
  if (!agentName) return;
  if (!/^[a-zA-Z0-9_]+$/.test(agentName)) { showToast('Agent 名称只能包含英文字母、数字和下划线'); return; }
  agentBusy.value = true;
  try {
    const payload = { agent_name: agentName };
    if (displayName) payload.display_name = displayName;
    if (description) payload.description = description;
    await createAgent(payload, selectedTeam.value);
    dictStore.invalidateAgents(selectedTeam.value);
    configsByTeam[selectedTeam.value] = await dictStore.ensureAgents(true, selectedTeam.value);
    displayMap.value = { ...displayMap.value, [agentName]: displayName || agentName };
    await refreshTeams();
    createVisible.value = false;
    selectedAgent.value = agentName;
    await loadAgentDetail();
    showToast(`Agent "${agentName}" 创建成功`, 'success');
  } catch (err) {
    showToast(err?.message || '创建 Agent 失败');
  } finally {
    agentBusy.value = false;
  }
}

async function handleDeleteAgent() {
  const name = selectedAgent.value;
  const accepted = await confirm({
    title: '删除 Agent',
    message: `确认从「${selectedTeam.value}」删除 Agent「${name}」？此操作不可撤销。`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!accepted) return;
  agentBusy.value = true;
  try {
    await deleteAgent(name, selectedTeam.value);
    dictStore.invalidateAgents(selectedTeam.value);
    const configs = await dictStore.ensureAgents(true, selectedTeam.value);
    configsByTeam[selectedTeam.value] = configs || {};
    await refreshTeams();
    const remaining = Object.keys(configs || {});
    selectedAgent.value = remaining[0] || '';
    if (selectedAgent.value) await loadAgentDetail();
    else clearForm();
    showToast(`Agent "${name}" 已删除`, 'success');
  } catch (err) {
    showToast(err?.message || '删除 Agent 失败');
  } finally {
    agentBusy.value = false;
  }
}

async function handleExport() {
  if (!selectedAgent.value) return;
  try {
    const { blob } = await exportAgentConfig(selectedAgent.value);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${selectedAgent.value}.yaml`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    showToast(err?.message || '导出配置失败');
  }
}

async function refreshTeams() {
  const summary = await dictStore.ensureTeams(true);
  teams.value = Array.isArray(summary.teams) ? summary.teams : [];
}

async function handleCreateTeam() {
  const { teamName, sourceTeam } = createTeamForm;
  if (!teamName) return;
  if (!/^[a-zA-Z0-9_]+$/.test(teamName)) { showToast('Team 名称只能包含英文字母、数字和下划线'); return; }
  teamBusy.value = true;
  try {
    await createTeam({ team_name: teamName, source_team: sourceTeam || undefined });
    createTeamDialogOpen.value = false;
    Object.assign(createTeamForm, { teamName: '', sourceTeam: '' });
    await loadAll(true);
    selectedTeam.value = teamName;
    selectedAgent.value = Object.keys(configsByTeam[teamName] || {})[0] || '';
    if (selectedAgent.value) await loadAgentDetail();
    showToast('Team 创建成功', 'success');
  } catch (err) {
    showToast(err?.message || '创建 Team 失败');
  } finally {
    teamBusy.value = false;
  }
}

async function handleActivateTeam(teamName) {
  const accepted = await confirm({
    title: '设为运行时默认',
    message: `确认将「${teamName}」设为运行时默认 Team？之后新对话将使用该 Team。`,
    confirmText: '设为默认',
    danger: false,
  });
  if (!accepted) return;
  teamBusy.value = true;
  try {
    await activateTeam(teamName);
    activeTeam.value = teamName;
    await dictStore.ensureTeams(true);
    showToast(`已将「${teamName}」设为运行时默认`, 'success');
  } catch (err) {
    showToast(err?.message || '设置默认 Team 失败');
  } finally {
    teamBusy.value = false;
  }
}

async function handleDeleteTeam(teamName) {
  const accepted = await confirm({
    title: '删除 Team',
    message: `确认删除 Team「${teamName}」？其下所有 Agent 配置将一并删除，此操作不可撤销。`,
    confirmText: '删除 Team',
    danger: true,
  });
  if (!accepted) return;
  teamBusy.value = true;
  try {
    await deleteTeam(teamName);
    if (selectedTeam.value === teamName) { selectedTeam.value = ''; selectedAgent.value = ''; }
    await loadAll(true);
    showToast('Team 删除成功', 'success');
  } catch (err) {
    showToast(err?.message || '删除 Team 失败');
  } finally {
    teamBusy.value = false;
  }
}

async function handleResetDefault() {
  teamBusy.value = true;
  try {
    await resetDefaultTeam();
    await loadAll(true);
    showToast('default team 已重置为系统默认配置', 'success');
  } catch (err) {
    showToast(err?.message || '重置 default team 失败');
  } finally {
    teamBusy.value = false;
  }
}

function getTierProviderKey(tier) {
  const t = form.value.llm_tiers[tier];
  if (!t?.provider) return '';
  const matched = providers.value.find((p) => p.name === t.provider && (!t.provider_type || p.provider_type === t.provider_type));
  return matched ? (matched.key || matched.name) : '';
}
function getTierModelOptions(tier) {
  const key = getTierProviderKey(tier);
  if (!key) return [];
  const p = providers.value.find((item) => (item?.key || item?.name) === key);
  return getProviderModels(p);
}
function handleTierProviderChange(tier, key) {
  const t = form.value.llm_tiers[tier];
  if (!t) return;
  if (!key) { t.provider = ''; t.provider_type = ''; return; }
  const p = providers.value.find((item) => (item?.key || item?.name) === key);
  if (!p) return;
  Object.assign(t, applyProviderToLlm(t, p));
}

onMounted(() => { loadAll(); });
</script>

<style scoped>
.studio-workbench {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
  align-items: stretch;
  gap: var(--spacing-md);
  overflow: hidden;
}

/* ===== 层次：画布(primary) → 工作区 Card(elevated) → 子项(tertiary) =====
   左右两栏都抬成卡片浮在画布上，边框+圆角+ elevated 底色撑出层次，不再融成一片。 */
.studio-nav-card {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-secondary);
}
.studio-nav__head {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
}
.studio-nav__title {
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--color-text-primary);
}
.studio-nav__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--spacing-sm);
}

.navigator-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.navigator-group + .navigator-group {
  margin-top: var(--spacing-md);
}
.navigator-group__label {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: 6px 8px;
  border-radius: var(--radius-sm);
}
.navigator-group__label--collapsible {
  cursor: pointer;
  user-select: none;
}
.navigator-group__label--collapsible:hover {
  background: var(--color-hover-overlay-md);
}
.navigator-group__caret {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  color: var(--color-text-muted);
  transition: transform var(--transition-fast);
}
.navigator-group__caret--collapsed {
  transform: rotate(-90deg);
}
.navigator-group__agents {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.navigator-group__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 600;
}
.navigator-group__count {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
.navigator-group__more {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
}
.navigator-group__label:hover .navigator-group__more,
.navigator-group__more[data-state='open'] {
  opacity: 1;
}
.navigator-group__more:hover {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}
.navigator-group__menu-danger {
  color: var(--color-error);
}
.navigator-row {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  min-width: 0;
  padding: 5px 8px 5px 16px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}
.navigator-row:hover {
  background: var(--color-hover-overlay-md);
}
.navigator-row--active {
  background: transparent;
}
/* Linear 式选中：accent 左侧条，而非整块底色 */
.navigator-row--active::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 6px;
  bottom: 6px;
  width: 2px;
  border-radius: var(--radius-full);
  background: var(--color-brand-accent);
}
.navigator-row--active:hover {
  background: var(--color-hover-overlay-md);
}
.navigator-row--static {
  cursor: default;
}
.navigator-row--static:hover {
  background: transparent;
}
.navigator-row--add {
  flex-direction: row;
  align-items: center;
  gap: 5px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
.navigator-row--add:hover {
  color: var(--color-brand-accent);
}
.navigator-row__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-xs);
}
.navigator-row__name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.navigator-row--active .navigator-row__name {
  font-weight: 500;
  color: var(--color-brand-accent);
}
.navigator-row__entry {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
.navigator-row p {
  margin: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.navigator-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: var(--spacing-sm);
  min-height: 160px;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
}
.navigator-state--error {
  color: var(--color-error);
}
.navigator-empty {
  min-height: 200px;
}

/* Team 管理下拉 */
/* ===== 右侧工作区（app-shell：头/标签栏/保存条常驻，仅 body 滚动）；抬成 elevated 主卡片 ===== */
.studio-panel-card {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-elevated);
}
.studio-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.workspace-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: var(--spacing-sm);
  min-height: 180px;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
  flex: 1;
}
.workspace-header {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-lg);
  padding: var(--spacing-lg) var(--spacing-xl) var(--spacing-md);
  border-bottom: 1px solid var(--color-border);
}
.workspace-header__identity {
  min-width: 0;
}
.workspace-header__title-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}
.workspace-header h2 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-xl);
  font-weight: 600;
}
.workspace-header p {
  margin: 4px 0 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
}
.workspace-header__actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.workspace-tabbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  padding: 0 var(--spacing-xl);
  border-bottom: 1px solid var(--color-border);
}
.workspace-tabs {
  border: none;
}
.workspace-tabs :deep([role='tablist']) {
  background: transparent;
  padding: 0;
  height: auto;
  gap: var(--spacing-lg);
  border: none;
}
.workspace-tab {
  position: relative;
}
.workspace-tabs :deep([role='tab']) {
  padding: 10px 2px;
  border-radius: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  color: var(--color-text-muted);
  font-weight: 500;
}
.workspace-tabs :deep([role='tab']:hover) {
  color: var(--color-text-secondary);
  background: transparent;
}
.workspace-tabs :deep([data-state='active']) {
  background: transparent;
  color: var(--color-text-primary);
  border-bottom-color: var(--color-brand-accent);
  box-shadow: none;
}
.workspace-tab__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 5px;
  border-radius: 50%;
  background: var(--color-warning);
  vertical-align: middle;
}
.workspace-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.workspace-pane {
  padding: var(--spacing-xl);
}
.workspace-savebar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-sm) var(--spacing-xl);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}
.workspace-savebar__state {
  font-size: var(--font-size-xs);
}
.workspace-savebar__state--dirty {
  color: var(--color-warning);
}
.workspace-savebar__state--saved {
  color: var(--color-text-muted);
}
.workspace-savebar__spacer {
  flex: 1;
}

.run-default-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  padding: 4px 12px;
}
.run-default-pill__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-success);
}

@media (max-width: 960px) {
  .studio-workbench {
    grid-template-columns: 1fr;
  }
  .studio-nav-card {
    position: static;
  }
  .workspace-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
