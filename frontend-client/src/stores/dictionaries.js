import { ref } from 'vue';
import { defineStore } from 'pinia';
import { getTeams, getAllAgentConfigs } from '../api/agentConfig.js';
import { getProviders } from '../api/modelAdapter.js';

/**
 * 字典单源：teams / agents / providers 的缓存与共享。
 * 替代各视图（Bots/AgentStudio/AdminCenter/KnowledgeBaseManager/MainLayout/
 * useChatSessionController）原本各自 getTeams/getAllAgentConfigs/getProviders 的重复拉取。
 *
 * ensureXxx 返回结构与原 api 函数一致（teams → {active_team, teams}；agents → {agent_name: config}；
 * providers → []），调用方下游代码无需改动。默认缓存；force=true 绕过缓存拿最新；
 * 修改类操作后调 invalidateAgents() 让下次 ensure 重新拉取。
 *
 * ensureAgents(force, teamName)：teamName 省略/空 → 当前激活 team（写入 agents）；
 * 指定 teamName → 按 team 缓存，不覆盖全局 agents。
 * force=true 无 team 时同时清空按 team 缓存，避免对话页命中过期 agents。
 */
export const useDictionariesStore = defineStore('dictionaries', () => {
  const teams = ref([]);
  const activeTeam = ref('');
  const agents = ref({});
  const providers = ref([]);

  let teamsPromise = null;
  let agentsPromise = null;
  let providersPromise = null;
  let agentsGeneration = 0;
  const agentsByTeam = new Map();
  const agentsByTeamPromises = new Map();
  const agentsByTeamGeneration = new Map();

  const clearTeamAgentCaches = () => {
    agentsByTeam.clear();
    agentsByTeamPromises.clear();
    agentsByTeamGeneration.clear();
  };

  const ensureTeams = async (force = false) => {
    if (teamsPromise && !force) return teamsPromise;
    teamsPromise = getTeams()
      .then((result) => {
        teams.value = result?.teams || [];
        activeTeam.value = result?.active_team || '';
        return { teams: teams.value, active_team: activeTeam.value };
      })
      .catch((err) => {
        teamsPromise = null;
        throw err;
      });
    return teamsPromise;
  };

  const ensureAgents = async (force = false, teamName = null) => {
    const team = typeof teamName === 'string' ? teamName.trim() : '';
    if (team) {
      if (!force && agentsByTeam.has(team)) {
        return agentsByTeam.get(team);
      }
      if (!force && agentsByTeamPromises.has(team)) {
        return agentsByTeamPromises.get(team);
      }

      const generation = (agentsByTeamGeneration.get(team) || 0) + 1;
      agentsByTeamGeneration.set(team, generation);
      if (force) {
        agentsByTeam.delete(team);
        agentsByTeamPromises.delete(team);
      }

      const promise = getAllAgentConfigs(team)
        .then((result) => {
          const data = result || {};
          if (agentsByTeamGeneration.get(team) === generation) {
            agentsByTeam.set(team, data);
            if (agentsByTeamPromises.get(team) === promise) {
              agentsByTeamPromises.delete(team);
            }
          }
          return data;
        })
        .catch((err) => {
          if (agentsByTeamPromises.get(team) === promise) {
            agentsByTeamPromises.delete(team);
          }
          throw err;
        });
      agentsByTeamPromises.set(team, promise);
      return promise;
    }

    if (agentsPromise && !force) return agentsPromise;
    if (force) {
      clearTeamAgentCaches();
      agentsPromise = null;
    }

    const generation = ++agentsGeneration;
    agentsPromise = getAllAgentConfigs()
      .then((result) => {
        const data = result || {};
        if (generation !== agentsGeneration) {
          return data;
        }
        agents.value = data;
        // 同步写入 active team 分桶，减少对话页重复请求
        const currentActive = activeTeam.value?.trim();
        if (currentActive) {
          agentsByTeam.set(currentActive, data);
        }
        return agents.value;
      })
      .catch((err) => {
        if (generation === agentsGeneration) {
          agentsPromise = null;
        }
        throw err;
      });
    return agentsPromise;
  };

  const ensureProviders = async (force = false) => {
    if (providersPromise && !force) return providersPromise;
    providersPromise = getProviders()
      .then((result) => {
        providers.value = Array.isArray(result) ? result : [];
        return providers.value;
      })
      .catch((err) => {
        providersPromise = null;
        throw err;
      });
    return providersPromise;
  };

  const invalidateAgents = (teamName = null) => {
    const team = typeof teamName === 'string' ? teamName.trim() : '';
    if (team) {
      agentsByTeam.delete(team);
      agentsByTeamPromises.delete(team);
      agentsByTeamGeneration.delete(team);
      return;
    }
    agentsGeneration += 1;
    agentsPromise = null;
    agents.value = {};
    clearTeamAgentCaches();
  };

  return {
    teams,
    activeTeam,
    agents,
    providers,
    ensureTeams,
    ensureAgents,
    ensureProviders,
    invalidateAgents,
  };
});
