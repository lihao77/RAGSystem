/**
 * Agent 管理动作：新建、删除、导出 YAML。
 * core 为 useAgentStudioCore 的返回值。
 */

import { reactive, ref } from 'vue';

import { createAgent, deleteAgent, exportAgentConfig } from '../../api/agentConfig.js';

const NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

export function useAgentAdmin(core, { confirm, showToast }) {
  const agentBusy = ref(false);
  const createVisible = ref(false);
  const createAgentForm = reactive({ agentName: '', displayName: '', description: '' });

  function openCreateAgent(team) {
    if (team && team !== core.selectedTeam.value) core.selectedTeam.value = team;
    Object.assign(createAgentForm, { agentName: '', displayName: '', description: '' });
    createVisible.value = true;
  }

  async function handleCreateAgent() {
    const { agentName, displayName, description } = createAgentForm;
    if (!agentName) return;
    if (!NAME_PATTERN.test(agentName)) { showToast('Agent 名称只能包含英文字母、数字和下划线'); return; }
    agentBusy.value = true;
    try {
      const payload = { agent_name: agentName };
      if (displayName) payload.display_name = displayName;
      if (description) payload.description = description;
      await createAgent(payload, core.selectedTeam.value);
      core.dictStore.invalidateAgents(core.selectedTeam.value);
      core.configsByTeam[core.selectedTeam.value] = await core.dictStore.ensureAgents(true, core.selectedTeam.value);
      core.displayMap.value = { ...core.displayMap.value, [agentName]: displayName || agentName };
      await core.refreshTeams();
      createVisible.value = false;
      core.selectedAgent.value = agentName;
      await core.loadAgentDetail();
      showToast(`Agent "${agentName}" 创建成功`, 'success');
    } catch (err) {
      showToast(err?.message || '创建 Agent 失败');
    } finally {
      agentBusy.value = false;
    }
  }

  async function handleDeleteAgent() {
    const name = core.selectedAgent.value;
    const accepted = await confirm({
      title: '删除 Agent',
      message: `确认从「${core.selectedTeam.value}」删除 Agent「${name}」？此操作不可撤销。`,
      confirmText: '确认删除',
      danger: true,
    });
    if (!accepted) return;
    agentBusy.value = true;
    try {
      await deleteAgent(name, core.selectedTeam.value);
      core.dictStore.invalidateAgents(core.selectedTeam.value);
      const configs = await core.dictStore.ensureAgents(true, core.selectedTeam.value);
      core.configsByTeam[core.selectedTeam.value] = configs || {};
      await core.refreshTeams();
      const remaining = Object.keys(configs || {});
      core.selectedAgent.value = remaining[0] || '';
      if (core.selectedAgent.value) await core.loadAgentDetail();
      else core.clearForm();
      showToast(`Agent "${name}" 已删除`, 'success');
    } catch (err) {
      showToast(err?.message || '删除 Agent 失败');
    } finally {
      agentBusy.value = false;
    }
  }

  async function handleExport() {
    if (!core.selectedAgent.value) return;
    try {
      const { blob } = await exportAgentConfig(core.selectedAgent.value);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${core.selectedAgent.value}.yaml`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      showToast(err?.message || '导出配置失败');
    }
  }

  return {
    agentBusy,
    createVisible,
    createAgentForm,
    openCreateAgent,
    handleCreateAgent,
    handleDeleteAgent,
    handleExport,
  };
}
