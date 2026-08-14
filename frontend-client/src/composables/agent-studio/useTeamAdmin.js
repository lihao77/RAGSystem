/**
 * Team 管理动作：新建（可复制）、设为运行时默认、删除、恢复默认配置。
 * core 为 useAgentStudioCore 的返回值。
 */

import { reactive, ref } from 'vue';

import { activateTeam, createTeam, deleteTeam, resetDefaultTeam } from '../../api/agentConfig.js';
import { BUILDER_TEAM } from './useAgentStudioCore.js';

const NAME_PATTERN = /^[a-zA-Z0-9_]+$/;

export function useTeamAdmin(core, { confirm, showToast }) {
  const teamBusy = ref(false);
  const createTeamDialogOpen = ref(false);
  const createTeamForm = reactive({ teamName: '', sourceTeam: '' });

  async function handleCreateTeam() {
    const { teamName, sourceTeam } = createTeamForm;
    if (!teamName) return;
    if (!NAME_PATTERN.test(teamName)) { showToast('Team 名称只能包含英文字母、数字和下划线'); return; }
    teamBusy.value = true;
    try {
      await createTeam({ team_name: teamName, source_team: sourceTeam || undefined });
      createTeamDialogOpen.value = false;
      Object.assign(createTeamForm, { teamName: '', sourceTeam: '' });
      await core.loadAll(true);
      core.selectedTeam.value = teamName;
      core.selectedAgent.value = Object.keys(core.configsByTeam[teamName] || {})[0] || '';
      if (core.selectedAgent.value) await core.loadAgentDetail();
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
      core.activeTeam.value = teamName;
      await core.dictStore.ensureTeams(true);
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
      if (core.selectedTeam.value === teamName) { core.selectedTeam.value = ''; core.selectedAgent.value = ''; }
      await core.loadAll(true);
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
      await core.loadAll(true);
      showToast('default team 已重置为系统默认配置', 'success');
    } catch (err) {
      showToast(err?.message || '重置 default team 失败');
    } finally {
      teamBusy.value = false;
    }
  }

  /** 导航树里可选的复制源（排除系统 Builder Team）。 */
  function teamCopySources() {
    return core.teams.value.filter((t) => t.team_name !== BUILDER_TEAM);
  }

  function openCreateTeamDialog() {
    createTeamDialogOpen.value = true;
  }

  return {
    teamBusy,
    createTeamDialogOpen,
    createTeamForm,
    handleCreateTeam,
    handleActivateTeam,
    handleDeleteTeam,
    handleResetDefault,
    teamCopySources,
    openCreateTeamDialog,
  };
}
