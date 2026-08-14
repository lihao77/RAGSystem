/**
 * AgentStudio 核心编排：Team/Agent 列表加载、Agent 详情加载、tab 切换守卫、保存。
 * Team/Agent 的增删见 useTeamAdmin / useAgentAdmin；插件 tab 见 useAgentPlugins。
 */

import { computed, reactive, ref } from 'vue';

import { getAgentConfig, updateAgentConfig } from '../../api/agentConfig.js';
import { applyConfigToForm, buildMainPayload, memoryScopeFallbackMeta } from '../../components/agent-studio/agentFormModel.js';
import { useAgentForm } from '../../components/agent-studio/useAgentForm.js';
import { useDictionariesStore } from '../../stores/dictionaries.js';
import { TAB_LABELS, useAgentPlugins } from './useAgentPlugins.js';

export const BUILDER_TEAM = 'agent-builder';

export function useAgentStudioCore({ confirm, showToast }) {
  const dictStore = useDictionariesStore();

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

  const { loadPluginConfigs, loadSupplementaryData, savePluginTab } = useAgentPlugins({
    selectedTeam, selectedAgent, pluginAvailability, tools, skills, mcpServers, providers, memoryScopeMeta, dictStore,
  });

  const providerOptions = computed(() => [
    { value: '', label: '未设置' },
    ...providers.value.map((p) => ({ value: p.key || p.name, label: `${p.name}${p.provider_type ? ` (${p.provider_type})` : ''}` })),
  ]);
  const peerAgents = computed(() => Object.keys(configsByTeam[selectedTeam.value] || {}).filter((a) => a !== selectedAgent.value));

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
  function isEntryAgent(teamName, agent) {
    return !!configsByTeam[teamName]?.[agent]?.default_entry;
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

  async function refreshAfterSave() {
    const [config, pluginConfigs] = await Promise.all([
      getAgentConfig(selectedAgent.value, selectedTeam.value),
      loadPluginConfigs(),
    ]);
    const { form: f, raw } = applyConfigToForm(config, pluginConfigs);
    applyConfigInPlace(f, raw);
    displayMap.value = { ...displayMap.value, [selectedAgent.value]: f.display_name || selectedAgent.value };
  }

  async function refreshTeams() {
    const summary = await dictStore.ensureTeams(true);
    teams.value = Array.isArray(summary.teams) ? summary.teams : [];
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

  /** 切 tab 守卫：离开有未保存修改的页时先确认，避免改完忘存。确认后保留脏标记只换页。 */
  async function handleTabChange(next) {
    const from = activeTab.value;
    if (!next || next === from) return;
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
      else await savePluginTab(tab, name, team, form.value);
      dictStore.invalidateAgents(team);
      await refreshAfterSave();
      showToast('保存成功', 'success');
    } catch (err) {
      showToast(err?.message || '保存配置失败');
    } finally {
      saving.value = false;
    }
  }

  return {
    dictStore,
    loading, error, teams, activeTeam, configsByTeam, displayMap, selectedTeam, selectedAgent,
    detailLoading, saving,
    form, rawConfig, dirty, activeTab, applyConfig, applyConfigInPlace, clearForm, resetTab,
    tools, skills, mcpServers, providers, memoryScopeMeta, pluginAvailability,
    providerOptions, peerAgents,
    collapsedTeams, isTeamCollapsed, toggleTeamCollapse, isEntryAgent,
    loadAll, loadAgentDetail, refreshAfterSave, refreshTeams,
    hasAnyDirty, onSelectAgent, handleTabChange, handleSave,
  };
}
