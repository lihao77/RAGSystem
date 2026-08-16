/**
 * Agent 配置表单模型：空表单构造、config→form 映射、form→payload 组装。
 * 从原 AgentConfig.vue 抽出，供工作台视图与各子组件共享。
 * 纯函数 + 常量，不持有响应式状态。
 */
import {
  parseExtraParamEntries,
  parseExtraParamsInput,
} from '../../utils/modelList.js';

/** 由配置自身/插件管理、不进入普通工具白名单的工具名。 */
export const configManagedToolNames = new Set([
  'list_memory_index',
  'read_memory_entry',
  'write_memory',
  'archive_memory',
  'request_user_input',
  'goal_create',
  'goal_get',
  'goal_update',
  'goal_list',
  'task_output',
  'task_stop',
  'agent',
  'list_child_agents',
  'call_agent',
  'send_message',
  'search_knowledge_base',
  'list_knowledge_collections',
  'activate_skill',
  'load_skill_resource',
  'get_skill_info',
  'execute_skill_script',
]);

export const extraParamTypeOptions = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'json', label: 'json' },
];

export const knowledgeSearchModes = [
  { value: 'hybrid', label: '混合搜索', description: '关键词与向量共同召回' },
  { value: 'vector', label: '向量搜索', description: '语义相似度召回' },
];

export const memoryScopeFallbackMeta = [
  { name: 'team', description: '团队级长期记忆，适合跨会话复用的共享偏好、约束与背景事实。' },
  { name: 'session', description: '当前会话记忆，适合记录本轮协作中形成的稳定偏好和上下文。' },
  { name: 'agent', description: '当前 team 内 Agent 私有记忆，仅适合该 Agent 在所属 team 中独立维护的长期信息。' },
  { name: 'workspace', description: '当前工作区记忆，优先绑定显式 workspace_root；若 session 未提供该字段，则自动回退到默认 session workspace。' },
  { name: 'user', description: '当前用户的长期记忆，适合跨团队和跨工作区复用的个人偏好、习惯与背景信息。' },
];

export function sanitizeEnabledTools(enabledTools) {
  return (Array.isArray(enabledTools) ? enabledTools : [])
    .filter((name) => !configManagedToolNames.has(name));
}

export function sanitizeAvailableTools(availableTools) {
  return (Array.isArray(availableTools) ? availableTools : [])
    .filter((tool) => tool?.name && !configManagedToolNames.has(tool.name));
}

export function createEmptyLLM() {
  return {
    provider: '',
    provider_type: '',
    model_name: '',
    temperature: 0.7,
    max_completion_tokens: 4096,
    max_context_tokens: 128000,
    thinking_level: '',
    extra_params_entries: [],
  };
}

export function createEmptyForm() {
  return {
    agent_name: '',
    display_name: '',
    description: '',
    enabled: true,
    default_entry: false,
    llm_tiers: { default: createEmptyLLM(), fast: null, powerful: null },
    tools: { enabled_tools: [] },
    goals: { enabled: false },
    tasks: { background: false },
    skills: { enabled_skills: [] },
    mcp: { enabled_servers: [] },
    memory: {
      enabled: true,
      auto_inject: true,
      allowed_scopes: ['team', 'session', 'user'],
      write_scopes: ['session', 'user'],
      archive_scopes: ['session', 'user'],
    },
    knowledge_base: {
      enabled: false,
      default_collection: 'documents',
      default_search_mode: 'hybrid',
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    delegation: { enabled_agents: [] },
    custom_params: { behavior: { system_prompt: '' } },
  };
}

function parseTierLLM(tier) {
  if (!tier) return null;
  return {
    provider: tier.provider || '',
    provider_type: tier.provider_type || '',
    model_name: tier.model_name || '',
    temperature: tier.temperature ?? 0.7,
    max_completion_tokens: tier.max_completion_tokens ?? 4096,
    max_context_tokens: tier.max_context_tokens ?? 128000,
    thinking_level: tier.thinking_level || '',
    extra_params_entries: parseExtraParamEntries(tier.extra_params),
  };
}

/** 把后端 config + 各插件 config 映射成编辑表单。返回 { form, raw }。 */
export function applyConfigToForm(config, pluginConfigs = {}) {
  const safeConfig = config || createEmptyForm();
  const empty = createEmptyForm();
  const memoryConfig = pluginConfigs.memory || empty.memory;
  const knowledgeConfig = pluginConfigs.knowledge || empty.knowledge_base;
  const skillsConfig = pluginConfigs.skills || empty.skills;
  const mcpConfig = pluginConfigs.mcp || empty.mcp;
  const raw = JSON.parse(JSON.stringify(safeConfig));
  const form = {
    agent_name: safeConfig.agent_name || '',
    display_name: safeConfig.display_name || '',
    description: safeConfig.description || '',
    enabled: safeConfig.enabled ?? true,
    default_entry: safeConfig.default_entry ?? safeConfig.custom_params?.default_entry ?? false,
    llm_tiers: {
      default: parseTierLLM(safeConfig.llm_tiers?.default) || createEmptyLLM(),
      fast: parseTierLLM(safeConfig.llm_tiers?.fast),
      powerful: parseTierLLM(safeConfig.llm_tiers?.powerful),
    },
    tools: { enabled_tools: sanitizeEnabledTools(safeConfig.tools?.enabled_tools) },
    goals: { enabled: !!safeConfig.goals?.enabled },
    tasks: { background: !!safeConfig.tasks?.background },
    skills: {
      enabled_skills: Array.isArray(skillsConfig.enabled_skills) ? [...skillsConfig.enabled_skills] : [],
    },
    mcp: {
      enabled_servers: Array.isArray(mcpConfig.enabled_servers) ? [...mcpConfig.enabled_servers] : [],
    },
    memory: {
      enabled: memoryConfig.enabled ?? true,
      auto_inject: memoryConfig.auto_inject ?? true,
      allowed_scopes: Array.isArray(memoryConfig.allowed_scopes) ? [...memoryConfig.allowed_scopes] : ['team', 'session', 'user'],
      write_scopes: Array.isArray(memoryConfig.write_scopes) ? [...memoryConfig.write_scopes] : ['session', 'user'],
      archive_scopes: Array.isArray(memoryConfig.archive_scopes) ? [...memoryConfig.archive_scopes] : ['session', 'user'],
    },
    delegation: {
      enabled_agents: Array.isArray(safeConfig.delegation?.enabled_agents) ? [...safeConfig.delegation.enabled_agents] : [],
    },
    knowledge_base: {
      enabled: knowledgeConfig.enabled ?? false,
      default_collection: knowledgeConfig.default_collection || 'documents',
      default_search_mode: knowledgeConfig.default_search_mode || 'hybrid',
      default_top_k: knowledgeConfig.default_top_k ?? 5,
      default_rerank: knowledgeConfig.default_rerank ?? false,
      default_reranker_key: knowledgeConfig.default_reranker_key || null,
    },
    custom_params: {
      ...(safeConfig.custom_params || {}),
      behavior: {
        ...(safeConfig.custom_params?.behavior || {}),
        system_prompt: safeConfig.custom_params?.behavior?.system_prompt || '',
      },
    },
  };
  return { form, raw };
}

function buildTier(tier, tierName) {
  if (!tier) return null;
  return {
    provider: tier.provider || null,
    provider_type: tier.provider_type || null,
    model_name: tier.model_name || null,
    temperature: tier.temperature === '' ? null : Number(tier.temperature),
    max_completion_tokens: tier.max_completion_tokens === '' ? null : Number(tier.max_completion_tokens),
    max_context_tokens: tier.max_context_tokens === '' ? null : Number(tier.max_context_tokens),
    thinking_level: tier.thinking_level || null,
    extra_params: parseExtraParamsInput(tier.extra_params_entries, `${tierName} 层级`),
  };
}

/** 组装主配置 PUT payload（剔除插件字段，那些走各自 API）。 */
export function buildMainPayload(form, rawConfig, agentName) {
  const merged = JSON.parse(JSON.stringify(rawConfig || {}));
  delete merged.memory;
  delete merged.knowledge_base;
  delete merged.skills;
  delete merged.mcp;
  merged.agent_name = agentName;
  merged.display_name = form.display_name;
  merged.description = form.description;
  merged.enabled = form.enabled;
  merged.default_entry = !!form.default_entry;

  const builtTiers = { default: buildTier(form.llm_tiers.default, 'default') };
  if (form.llm_tiers.fast) builtTiers.fast = buildTier(form.llm_tiers.fast, 'fast');
  if (form.llm_tiers.powerful) builtTiers.powerful = buildTier(form.llm_tiers.powerful, 'powerful');
  merged.llm_tiers = Object.keys(builtTiers).length ? builtTiers : null;

  // 工具只通过 enabled_tools 白名单维护，重建对象以丢弃旧配置里的退役字段。
  merged.tools = { enabled_tools: sanitizeEnabledTools(form.tools.enabled_tools) };

  merged.goals = { enabled: !!form.goals.enabled };
  merged.tasks = { background: !!form.tasks.background };

  merged.delegation = {
    ...(merged.delegation || {}),
    enabled_agents: form.delegation.enabled_agents,
  };

  merged.custom_params = form.custom_params || merged.custom_params || {};
  if (Object.prototype.hasOwnProperty.call(merged.custom_params, 'default_entry')) {
    delete merged.custom_params.default_entry;
  }
  return merged;
}

export function buildMemoryPluginConfig(form) {
  return {
    enabled: !!form.memory.enabled,
    auto_inject: !!form.memory.auto_inject,
    allowed_scopes: form.memory.allowed_scopes,
    write_scopes: form.memory.write_scopes,
    archive_scopes: form.memory.archive_scopes,
  };
}

export function buildKnowledgePluginConfig(form) {
  return {
    enabled: !!form.knowledge_base.enabled,
    default_collection: form.knowledge_base.default_collection || 'documents',
    default_search_mode: form.knowledge_base.default_search_mode || 'hybrid',
    default_top_k: Number(form.knowledge_base.default_top_k) || 5,
    default_rerank: !!form.knowledge_base.default_rerank,
    default_reranker_key: form.knowledge_base.default_reranker_key || null,
  };
}

export function buildSkillsPluginConfig(form) {
  return { enabled_skills: form.skills.enabled_skills };
}

export function buildMcpPluginConfig(form) {
  return { enabled_servers: form.mcp.enabled_servers };
}
