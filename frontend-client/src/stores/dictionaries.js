import { ref } from 'vue';
import { defineStore } from 'pinia';
import { getTeams, getAllAgentConfigs } from '../api/agentConfig.js';
import { getProviders } from '../api/modelAdapter.js';

/**
 * 字典单源：teams / agents / providers 的缓存与共享。
 * 替代各视图（Bots/AgentConfig/TeamBuilder/AdminCenter/KnowledgeBaseManager/MainLayout/
 * useChatSessionController）原本各自 getTeams/getAllAgentConfigs/getProviders 的重复拉取。
 *
 * ensureXxx 返回结构与原 api 函数一致（teams → {active_team, teams}；agents → {agent_name: config}；
 * providers → []），调用方下游代码无需改动。默认缓存；force=true 绕过缓存拿最新；
 * 修改类操作后调 invalidate() 让下次 ensure 重新拉取。
 */
export const useDictionariesStore = defineStore('dictionaries', () => {
  const teams = ref([]);
  const activeTeam = ref('');
  const agents = ref({});
  const providers = ref([]);

  let teamsPromise = null;
  let agentsPromise = null;
  let providersPromise = null;

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

  const ensureAgents = async (force = false) => {
    if (agentsPromise && !force) return agentsPromise;
    agentsPromise = getAllAgentConfigs()
      .then((result) => {
        agents.value = result || {};
        return agents.value;
      })
      .catch((err) => {
        agentsPromise = null;
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

  return {
    teams,
    activeTeam,
    agents,
    providers,
    ensureTeams,
    ensureAgents,
    ensureProviders,
  };
});
