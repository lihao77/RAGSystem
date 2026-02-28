<template>
  <div class="agent-config-page">
    <div class="config-shell">
      <header class="config-header">
        <div class="header-left">
          <button class="btn-back" @click="navigateToChat">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
            返回聊天
          </button>
          <div class="header-meta">
            <h1 class="config-title">Agent 配置</h1>
            <p class="config-subtitle">统一管理智能体基础参数、模型、工具与 Skills</p>
          </div>
        </div>
      </header>

      <div v-if="loading" class="state-panel state-panel--loading">
        <div class="spinner"></div>
        <p>加载中...</p>
      </div>

      <div v-else-if="error" class="state-panel state-panel--error">
        <p>{{ error }}</p>
        <button class="btn-secondary" @click="loadInitialData">重试</button>
      </div>

      <div v-else class="config-card">
        <div class="config-card__head">
          <label class="field-label" for="agent-select">选择 Agent</label>
          <CustomSelect
            id="agent-select"
            :model-value="selectedAgent"
            :options="agents.map(a => ({ value: a, label: a }))"
            placeholder="请选择 Agent"
            @update:model-value="selectedAgent = $event; handleAgentChange()"
          />
        </div>

        <div v-if="!selectedAgent" class="state-panel state-panel--empty">
          <p>暂无可配置的 Agent</p>
        </div>

        <form v-else class="config-form" @submit.prevent="handleSave">
          <section class="form-section">
            <div class="section-head">
              <h2>基础信息</h2>
              <span>Agent 基本展示与启用状态</span>
            </div>
            <div class="section-body form-grid">
              <label class="form-item">
                <span class="field-label-text">显示名称</span>
                <input v-model="configForm.display_name" type="text" class="form-control" />
              </label>

              <label class="form-item">
                <span class="field-label-text">描述</span>
                <input v-model="configForm.description" type="text" class="form-control" />
              </label>

              <label class="form-item checkbox-item checkbox-item--inline">
                <input v-model="configForm.enabled" type="checkbox" />
                <span class="field-label-text">启用该 Agent</span>
              </label>
            </div>
          </section>

          <section class="form-section">
            <div class="section-head">
              <h2>LLM 配置</h2>
              <span>Provider 自动同步默认参数，可按需覆盖</span>
            </div>
            <div class="section-body form-grid">
              <label class="form-item">
                <span class="field-label-text">Provider</span>
                <CustomSelect
                  :model-value="selectedProviderKey"
                  :options="[{ value: '', label: '未设置（使用默认）' }, ...providers.map(p => ({ value: p.key || p.name, label: p.name + (p.provider_type ? ` (${p.provider_type})` : '') }))]"
                  placeholder="未设置（使用默认）"
                  @update:model-value="selectedProviderKey = $event; handleProviderChange()"
                />
              </label>

              <label class="form-item">
                <span class="field-label-text">Provider Type</span>
                <input :value="configForm.llm.provider_type || '未设置'" type="text" class="form-control" disabled />
                <small class="field-hint">只读字段，随 Provider 自动更新</small>
              </label>

              <label class="form-item">
                <span class="field-label-text">Model Name</span>
                <CustomSelect
                  :model-value="configForm.llm.model_name"
                  :options="[{ value: '', label: '选择模型' }, ...providerModelOptions.map(m => ({ value: m, label: m }))]"
                  placeholder="选择模型"
                  @update:model-value="configForm.llm.model_name = $event; handleModelChange()"
                />
                <small class="field-hint">可从列表选择，或保存后手动编辑配置文件指定自定义模型</small>
              </label>

              <label class="form-item">
                <span class="field-label-text">Temperature</span>
                <input v-model.number="configForm.llm.temperature" type="number" class="form-control" min="0" max="2" step="0.1" />
              </label>

              <label class="form-item">
                <span class="field-label-text">Max Completion Tokens</span>
                <input v-model.number="configForm.llm.max_completion_tokens" type="number" class="form-control" min="1" step="1" />
              </label>

              <label class="form-item">
                <span class="field-label-text">Max Context Tokens</span>
                <input v-model.number="configForm.llm.max_context_tokens" type="number" class="form-control" min="1" step="1" />
              </label>
            </div>
          </section>

          <section class="form-section">
            <div class="section-head">
              <h2>LLM 分层配置</h2>
              <span>可选。fast 用于压缩等简单任务，powerful 用于复杂推理</span>
            </div>
            <div class="section-body">
              <div v-for="tier in ['fast', 'powerful']" :key="tier" class="tier-block">
                <div class="tier-block__head">
                  <div class="toggle-card"
                    :class="{ active: !!configForm.llm_tiers[tier] }"
                    style="flex:1"
                    @click="configForm.llm_tiers[tier] = configForm.llm_tiers[tier] ? null : createEmptyLLM()"
                  >
                    <div class="toggle-card__indicator">
                      <svg v-if="configForm.llm_tiers[tier]"
                        xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                        viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    </div>
                    <div class="toggle-card__name">{{ tier }}</div>
                    <div class="toggle-card__desc">{{ tier === 'fast' ? '简单任务（压缩、格式化等），成本优化' : '复杂推理任务（可选）' }}</div>
                  </div>
                </div>
                <div v-if="configForm.llm_tiers[tier]" class="form-grid tier-block__body">
                  <label class="form-item">
                    <span class="field-label-text">Provider</span>
                    <CustomSelect
                      :model-value="getTierProviderKey(tier)"
                      :options="[{ value: '', label: '未设置' }, ...providers.map(p => ({ value: p.key || p.name, label: p.name + (p.provider_type ? ` (${p.provider_type})` : '') }))]"
                      placeholder="未设置"
                      @update:model-value="handleTierProviderChange(tier, $event)"
                    />
                  </label>
                  <label class="form-item">
                    <span class="field-label-text">Provider Type</span>
                    <input :value="configForm.llm_tiers[tier].provider_type || '未设置'" type="text" class="form-control" disabled />
                  </label>
                  <label class="form-item">
                    <span class="field-label-text">Model Name</span>
                    <CustomSelect
                      :model-value="configForm.llm_tiers[tier].model_name"
                      :options="[{ value: '', label: '选择模型' }, ...getTierModelOptions(tier).map(m => ({ value: m, label: m }))]"
                      placeholder="选择模型"
                      @update:model-value="configForm.llm_tiers[tier].model_name = $event"
                    />
                  </label>
                  <label class="form-item">
                    <span class="field-label-text">Temperature</span>
                    <input v-model.number="configForm.llm_tiers[tier].temperature" type="number" class="form-control" min="0" max="2" step="0.1" />
                  </label>
                  <label class="form-item">
                    <span class="field-label-text">Max Completion Tokens</span>
                    <input v-model.number="configForm.llm_tiers[tier].max_completion_tokens" type="number" class="form-control" min="1" step="1" />
                  </label>
                  <label class="form-item">
                    <span class="field-label-text">Max Context Tokens</span>
                    <input v-model.number="configForm.llm_tiers[tier].max_context_tokens" type="number" class="form-control" min="1" step="1" />
                  </label>
                </div>
              </div>
            </div>
          </section>

          <section class="form-section">
            <div class="section-head">
              <h2>工具</h2>
              <span>选择当前 Agent 可使用的工具能力</span>
            </div>
            <div class="section-body toggle-grid">
              <div
                v-for="tool in tools"
                :key="tool.name"
                class="toggle-card"
                :class="{ active: configForm.tools.enabled_tools.includes(tool.name) }"
                @click="toggleTool(tool.name, !configForm.tools.enabled_tools.includes(tool.name))"
              >
                <div class="toggle-card__indicator">
                  <svg v-if="configForm.tools.enabled_tools.includes(tool.name)"
                    xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
                <div class="toggle-card__name">{{ tool.display_name || tool.name }}</div>
                <div class="toggle-card__desc">{{ tool.description || tool.name }}</div>
              </div>
            </div>
          </section>

          <section class="form-section">
            <div class="section-head">
              <h2>Skills</h2>
              <span>管理领域知识与脚本能力注入</span>
            </div>
            <div class="section-body skills-body">
              <label class="form-item checkbox-item checkbox-item--inline">
                <input v-model="configForm.skills.auto_inject" type="checkbox" />
                <span>自动注入 Skills</span>
              </label>

              <div class="toggle-grid">
                <div
                  v-for="skill in skills"
                  :key="skill.name"
                  class="toggle-card"
                  :class="{ active: configForm.skills.enabled_skills.includes(skill.name) }"
                  @click="toggleSkill(skill.name, !configForm.skills.enabled_skills.includes(skill.name))"
                >
                  <div class="toggle-card__indicator">
                    <svg v-if="configForm.skills.enabled_skills.includes(skill.name)"
                      xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                      viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  </div>
                  <div class="toggle-card__name">{{ skill.display_name || skill.name }}</div>
                  <div class="toggle-card__desc">{{ skill.description || skill.name }}</div>
                </div>
              </div>
            </div>
          </section>

          <footer class="form-actions">
            <button type="submit" class="btn-primary" :disabled="saving || agentLoading">
              {{ saving ? '保存中...' : '保存配置' }}
            </button>
          </footer>
        </form>
      </div>
    </div>
    <AppToast ref="toastRef" />
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import {
  getAllAgentConfigs,
  getAgentConfig,
  updateAgentConfig,
  getAvailableTools,
  getAvailableSkills
} from '../api/agentConfig';
import { getProviders } from '../api/llmAdapter';
import CustomSelect from '../components/CustomSelect.vue';
import AppToast from '../components/AppToast.vue';

const emit = defineEmits(['navigate']);

const loading = ref(false);
const saving = ref(false);
const agentLoading = ref(false);
const error = ref('');
const toastRef = ref(null);

function showToast(message, type = 'error') {
  toastRef.value?.show(message, type);
}

const agents = ref([]);
const selectedAgent = ref('');
const tools = ref([]);
const skills = ref([]);
const providers = ref([]);

const configForm = ref(createEmptyForm());
const rawConfig = ref(createEmptyForm());
const selectedProviderKey = ref('');

const selectedProviderEntry = computed(() => {
  if (!selectedProviderKey.value) return null;
  return providers.value.find(item => (item?.key || item?.name) === selectedProviderKey.value) || null;
});

function getProviderModels(provider) {
  if (!provider) return [];

  const fromMap = provider.model_map?.chat;
  if (fromMap != null) {
    if (Array.isArray(fromMap)) return fromMap.filter(Boolean);
    return [String(fromMap)];
  }

  if (Array.isArray(provider.models) && provider.models.length > 0) {
    return provider.models.filter(Boolean);
  }

  if (provider.model) return [provider.model];
  return [];
}

const providerModelOptions = computed(() => {
  return getProviderModels(selectedProviderEntry.value);
});

function createEmptyLLM() {
  return { provider: '', provider_type: '', model_name: '', temperature: 0.7, max_completion_tokens: 4096, max_context_tokens: 128000 };
}

function createEmptyForm() {
  return {
    agent_name: '',
    display_name: '',
    description: '',
    enabled: true,
    llm: createEmptyLLM(),
    llm_tiers: { fast: null, powerful: null },
    tools: { enabled_tools: [] },
    skills: { enabled_skills: [], auto_inject: true },
    custom_params: {}
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
    max_context_tokens: tier.max_context_tokens ?? 128000
  };
}

function applyConfigToForm(config) {
  const safeConfig = config || createEmptyForm();
  rawConfig.value = JSON.parse(JSON.stringify(safeConfig));
  configForm.value = {
    agent_name: safeConfig.agent_name || '',
    display_name: safeConfig.display_name || '',
    description: safeConfig.description || '',
    enabled: safeConfig.enabled ?? true,
    llm: {
      provider: safeConfig.llm?.provider || '',
      provider_type: safeConfig.llm?.provider_type || '',
      model_name: safeConfig.llm?.model_name || '',
      temperature: safeConfig.llm?.temperature ?? 0.7,
      max_completion_tokens: safeConfig.llm?.max_completion_tokens ?? 4096,
      max_context_tokens: safeConfig.llm?.max_context_tokens ?? 128000
    },
    llm_tiers: {
      fast: parseTierLLM(safeConfig.llm_tiers?.fast),
      powerful: parseTierLLM(safeConfig.llm_tiers?.powerful)
    },
    tools: {
      enabled_tools: Array.isArray(safeConfig.tools?.enabled_tools) ? [...safeConfig.tools.enabled_tools] : []
    },
    skills: {
      enabled_skills: Array.isArray(safeConfig.skills?.enabled_skills) ? [...safeConfig.skills.enabled_skills] : [],
      auto_inject: safeConfig.skills?.auto_inject ?? true
    },
    custom_params: safeConfig.custom_params || {}
  };

  const matched = providers.value.find(item =>
    item?.name === configForm.value.llm.provider &&
    (!configForm.value.llm.provider_type || item?.provider_type === configForm.value.llm.provider_type)
  );
  selectedProviderKey.value = matched ? (matched.key || matched.name) : '';
}

function buildPayload() {
  const merged = JSON.parse(JSON.stringify(rawConfig.value || {}));
  merged.agent_name = selectedAgent.value;
  merged.display_name = configForm.value.display_name;
  merged.description = configForm.value.description;
  merged.enabled = configForm.value.enabled;

  merged.llm = {
    ...(merged.llm || {}),
    provider: configForm.value.llm.provider || null,
    provider_type: configForm.value.llm.provider_type || null,
    model_name: configForm.value.llm.model_name || null,
    temperature: configForm.value.llm.temperature === '' ? null : Number(configForm.value.llm.temperature),
    max_completion_tokens: configForm.value.llm.max_completion_tokens === '' ? null : Number(configForm.value.llm.max_completion_tokens),
    max_context_tokens: configForm.value.llm.max_context_tokens === '' ? null : Number(configForm.value.llm.max_context_tokens)
  };

  function buildTier(tier) {
    if (!tier) return null;
    return {
      provider: tier.provider || null,
      provider_type: tier.provider_type || null,
      model_name: tier.model_name || null,
      temperature: tier.temperature === '' ? null : Number(tier.temperature),
      max_completion_tokens: tier.max_completion_tokens === '' ? null : Number(tier.max_completion_tokens),
      max_context_tokens: tier.max_context_tokens === '' ? null : Number(tier.max_context_tokens)
    };
  }
  const tiers = configForm.value.llm_tiers;
  const builtTiers = {};
  if (tiers.fast) builtTiers.fast = buildTier(tiers.fast);
  if (tiers.powerful) builtTiers.powerful = buildTier(tiers.powerful);
  merged.llm_tiers = Object.keys(builtTiers).length ? builtTiers : null;

  merged.tools = {
    ...(merged.tools || {}),
    enabled_tools: configForm.value.tools.enabled_tools
  };

  merged.skills = {
    ...(merged.skills || {}),
    enabled_skills: configForm.value.skills.enabled_skills,
    auto_inject: configForm.value.skills.auto_inject
  };

  merged.custom_params = configForm.value.custom_params || merged.custom_params || {};
  return merged;
}

async function loadInitialData() {
  loading.value = true;
  error.value = '';

  try {
    const [configs, toolList, skillList, providerList] = await Promise.all([
      getAllAgentConfigs(),
      getAvailableTools(),
      getAvailableSkills(),
      getProviders()
    ]);

    tools.value = Array.isArray(toolList) ? toolList : [];
    skills.value = Array.isArray(skillList) ? skillList : [];
    providers.value = Array.isArray(providerList) ? providerList : [];

    const agentNames = Object.keys(configs || {});
    agents.value = agentNames;

    if (agentNames.length > 0) {
      selectedAgent.value = agentNames[0];
      await loadAgentDetail(agentNames[0]);
    } else {
      selectedAgent.value = '';
      configForm.value = createEmptyForm();
      rawConfig.value = createEmptyForm();
    }
  } catch (err) {
    error.value = err.message || '加载 Agent 配置失败';
  } finally {
    loading.value = false;
  }
}

async function loadAgentDetail(agentName) {
  if (!agentName) return;

  agentLoading.value = true;

  try {
    const config = await getAgentConfig(agentName);
    applyConfigToForm(config);
  } catch (err) {
    showToast(err.message || '加载 Agent 详情失败');
  } finally {
    agentLoading.value = false;
  }
}

async function handleAgentChange() {
  await loadAgentDetail(selectedAgent.value);
}

async function handleSave() {
  if (!selectedAgent.value) return;

  if (!configForm.value.llm.provider) {
    showToast('请选择主 LLM 的 Provider');
    return;
  }
  for (const tier of ['fast', 'powerful']) {
    const t = configForm.value.llm_tiers[tier];
    if (t && !t.provider) {
      showToast(`请选择 ${tier} 层级的 Provider，或禁用该层级`);
      return;
    }
  }

  saving.value = true;

  try {
    await updateAgentConfig(selectedAgent.value, buildPayload());
    const latest = await getAgentConfig(selectedAgent.value);
    applyConfigToForm(latest);
    showToast('保存成功', 'success');
  } catch (err) {
    showToast(err.message || '保存配置失败');
  } finally {
    saving.value = false;
  }
}

function getTierProviderKey(tier) {
  const t = configForm.value.llm_tiers[tier];
  if (!t?.provider) return '';
  const matched = providers.value.find(p => p.name === t.provider && (!t.provider_type || p.provider_type === t.provider_type));
  return matched ? (matched.key || matched.name) : '';
}

function getTierModelOptions(tier) {
  const key = getTierProviderKey(tier);
  if (!key) return [];
  const p = providers.value.find(item => (item?.key || item?.name) === key);
  return getProviderModels(p);
}

function handleTierProviderChange(tier, key) {
  const t = configForm.value.llm_tiers[tier];
  if (!t) return;
  if (!key) { t.provider = ''; t.provider_type = ''; return; }
  const p = providers.value.find(item => (item?.key || item?.name) === key);
  if (!p) return;
  t.provider = p.name || '';
  t.provider_type = p.provider_type || '';
  const models = getProviderModels(p);
  t.model_name = models[0] || '';
  if (p.temperature != null) t.temperature = Number(p.temperature);
  if (p.max_completion_tokens != null) t.max_completion_tokens = Number(p.max_completion_tokens);
  if (p.max_context_tokens != null) t.max_context_tokens = Number(p.max_context_tokens);
}

function toggleTool(name, checked) {
  const list = configForm.value.tools.enabled_tools;
  if (checked && !list.includes(name)) {
    list.push(name);
  } else if (!checked) {
    configForm.value.tools.enabled_tools = list.filter(item => item !== name);
  }
}

function toggleSkill(name, checked) {
  const list = configForm.value.skills.enabled_skills;
  if (checked && !list.includes(name)) {
    list.push(name);
  } else if (!checked) {
    configForm.value.skills.enabled_skills = list.filter(item => item !== name);
  }
}

function syncLLMWithProviderDefaults({ keepCurrentModel = true } = {}) {
  const provider = selectedProviderEntry.value;
  if (!provider) return;

  configForm.value.llm.provider = provider.name || '';
  configForm.value.llm.provider_type = provider.provider_type || '';

  const models = getProviderModels(provider);
  const currentModel = configForm.value.llm.model_name;
  if (!keepCurrentModel || !currentModel || !models.includes(currentModel)) {
    configForm.value.llm.model_name = models[0] || provider.model || currentModel || '';
  }

  if (provider.temperature != null) {
    configForm.value.llm.temperature = Number(provider.temperature);
  }
  if (provider.max_completion_tokens != null) {
    configForm.value.llm.max_completion_tokens = Number(provider.max_completion_tokens);
  }
  if (provider.max_context_tokens != null) {
    configForm.value.llm.max_context_tokens = Number(provider.max_context_tokens);
  }
}

function handleProviderChange() {
  if (!selectedProviderKey.value) {
    configForm.value.llm.provider = '';
    configForm.value.llm.provider_type = '';
    return;
  }

  syncLLMWithProviderDefaults({ keepCurrentModel: false });
}

function handleModelChange() {
  syncLLMWithProviderDefaults({ keepCurrentModel: true });
}

function navigateToChat() {
  emit('navigate', '/');
}

onMounted(() => {
  loadInitialData();
});
</script>

<style scoped src="../styles/agent-config.css"></style>
