/**
 * Agent 插件 tab 的表驱动编排：skills/memory/mcp/knowledge 四类插件配置的
 * 加载、可用性探测与保存。替代原视图里 per-tab 的手写 load/save 分支。
 */

import {
  getAvailableMCPServers,
  getAvailableTools,
  getMcpAgentConfig,
  updateMcpAgentConfig,
} from '../../api/agentConfig.js';
import { getAvailableSkills, getSkillsAgentConfig, updateSkillsAgentConfig } from '../../api/skillLibrary.js';
import { getMemoryAgentConfig, getMemoryConfigMetadata, updateMemoryAgentConfig } from '../../api/memory.js';
import { getKnowledgeAgentConfig, updateKnowledgeAgentConfig } from '../../api/knowledgeBase.js';
import {
  buildKnowledgePluginConfig,
  buildMcpPluginConfig,
  buildMemoryPluginConfig,
  buildSkillsPluginConfig,
  memoryScopeFallbackMeta,
  sanitizeAvailableTools,
} from '../../components/agent-studio/agentFormModel.js';

export const TAB_LABELS = { config: '配置', skills: '技能', memory: '记忆', mcp: 'MCP', knowledge: '知识库' };

const PLUGIN_TABS = {
  skills: { load: getSkillsAgentConfig, save: updateSkillsAgentConfig, build: buildSkillsPluginConfig },
  memory: { load: getMemoryAgentConfig, save: updateMemoryAgentConfig, build: buildMemoryPluginConfig },
  mcp: { load: getMcpAgentConfig, save: updateMcpAgentConfig, build: buildMcpPluginConfig },
  knowledge: { load: getKnowledgeAgentConfig, save: updateKnowledgeAgentConfig, build: buildKnowledgePluginConfig },
};

/**
 * @param refs 由 core 提供的响应式引用集合（selectedTeam/selectedAgent/pluginAvailability/tools/skills/…）
 */
export function useAgentPlugins(refs) {
  const { selectedTeam, selectedAgent, pluginAvailability, tools, skills, mcpServers, providers, memoryScopeMeta, dictStore } = refs;

  /** 拉取四类插件配置；可用性按请求是否成功判定（插件未启用时后端 404/400）。 */
  async function loadPluginConfigs() {
    const team = selectedTeam.value;
    const name = selectedAgent.value;
    const entries = await Promise.all(
      Object.entries(PLUGIN_TABS).map(async ([key, tab]) => {
        try {
          return [key, await tab.load(name, team)];
        } catch {
          return [key, null];
        }
      }),
    );
    const configs = {};
    for (const [key, value] of entries) {
      pluginAvailability[key] = value !== null;
      configs[key] = value;
    }
    return configs;
  }

  /** 加载字典类补充数据（工具/技能/MCP 服务/Provider/记忆 scope 元数据）。 */
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

  /** 保存某个插件 tab（config 主表单不在此列）。 */
  async function savePluginTab(tab, name, team, form) {
    const spec = PLUGIN_TABS[tab];
    if (!spec) throw new Error(`未知配置分区: ${tab}`);
    await spec.save(name, spec.build(form), team);
  }

  return { loadPluginConfigs, loadSupplementaryData, savePluginTab };
}
