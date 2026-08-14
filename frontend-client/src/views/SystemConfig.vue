<template>
  <PageLayout title="系统配置" subtitle="记忆与系统运行参数">
    <template #header-actions>
      <Button variant="ghost" size="icon-sm" :disabled="loading || saving" aria-label="重新加载" title="重新加载" @click="handleReload">
        <IconRefresh :size="16" />
      </Button>
      <Button variant="ghost" size="icon-sm" :disabled="loading || saving" :aria-label="saving ? '保存中' : '保存配置'" :title="saving ? '保存中' : '保存配置'" @click="handleSave">
        <IconSave :size="16" />
      </Button>
    </template>

    <template #mobile-menu="{ close }">
      <button class="pl-menu-item" :disabled="loading || saving" @click="handleReload(); close()">
        <IconRefresh :size="16" />
        重新加载
      </button>
      <button class="pl-menu-item" :disabled="loading || saving" @click="handleSave(); close()">
        <IconSave :size="16" />
        {{ saving ? '保存中...' : '保存配置' }}
      </button>
    </template>

    <EntityListLayout
      v-if="loading || error"
      title="系统配置数据"
      description="加载记忆与系统运行参数。"
      :loading="loading"
      loading-text="加载系统配置..."
      :error="error"
      @retry="loadData"
    />

    <template v-else>
      <div class="config-form">
        <SchemaForm :model-value="configData" :schema="configSchema" @update:model-value="handleConfigChange">
          <template #group-after="{ group }">
            <div v-if="group.key === 'llm' && configData.llm" class="extra-param-editor">
              <div class="field-label-row">
                <span class="field-label-text">额外参数</span>
                <Button type="button" size="sm" @click="addExtraParam">新增参数</Button>
              </div>
              <div class="extra-param-content">
                <div v-if="extraParamEntries.length" class="extra-param-list">
                  <div v-for="(entry, index) in extraParamEntries" :key="`system-${index}`" class="extra-param-row">
                    <Input v-model.trim="entry.key" type="text" placeholder="key" />
                    <CustomSelect :model-value="entry.type" :options="extraParamTypeOptions" placeholder="type" @update:model-value="entry.type = $event" />
                    <Input v-model="entry.value" type="text" placeholder="value" />
                    <Button type="button" size="sm" variant="destructive" class="extra-param-delete-button" @click="removeExtraParam(index)">删除</Button>
                  </div>
                </div>
                <div v-else class="state-panel state-panel--empty state-panel--compact adm-state adm-state--empty">
                  <p>暂无额外参数</p>
                </div>
              </div>
              <small class="field-hint">type 可选 string / number / boolean / json，json 类型的 value 需填写合法 JSON</small>
            </div>
          </template>
        </SchemaForm>
      </div>
    </template>

  </PageLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import PageLayout from '../components/PageLayout.vue';
import IconRefresh from '../components/icons/IconRefresh.vue';
import IconSave from '../components/icons/IconSave.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import SchemaForm from '../components/SchemaForm.vue';
import { getProviders } from '../api/modelAdapter.js';
import CustomSelect from '../components/ui/CustomSelect.vue';
import { Input } from '../components/ui/input';
import {
  applyProviderToLlm,
  createExtraParamEntry,
  getProviderModels,
  parseExtraParamEntries,
  parseExtraParamsInput,
} from '../utils/modelList.js';
import { Button } from '../components/ui/button';
import { showToast } from '../composables/useToast.js';
import {
  getSystemConfigSchema,
  getSystemConfig,
  updateSystemConfig,
  reloadSystemConfig,
} from '../api/systemConfig.js';

const baseConfigSchema = ref({ groups: [] });
const configData = ref({});
const providers = ref([]);
const extraParamEntries = ref([]);
const extraParamTypeOptions = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'json', label: 'json' },
];
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const configSchema = computed(() => enrichSchemaWithProviderSelection(baseConfigSchema.value, configData.value));


async function loadData() {
  loading.value = true;
  error.value = '';
  try {
    const [schema, config, providerResult] = await Promise.all([
      getSystemConfigSchema(),
      getSystemConfig(),
      getProviders().catch(() => []),
    ]);
    providers.value = Array.isArray(providerResult) ? providerResult : [];
    configData.value = config;
    extraParamEntries.value = parseExtraParamEntries(config?.llm?.extra_params);
    baseConfigSchema.value = schema;
  } catch (e) {
    error.value = e.message || '加载配置失败';
  } finally {
    loading.value = false;
  }
}

const PROVIDER_SELECT_GROUPS = ['llm', 'image_tools'];

function findSelectedProvider(groupConfig) {
  const providerName = String(groupConfig?.provider || '').trim();
  const providerType = String(groupConfig?.provider_type || '').trim();
  if (!providerName) return null;
  return providers.value.find((provider) => {
    const identifiers = [provider?.name, provider?.key].map((value) => String(value || '').trim());
    return identifiers.includes(providerName)
      && (!providerType || String(provider?.provider_type || '').trim() === providerType);
  }) || null;
}

/**
 * 将含 provider/model_name 字段的配置组动态化为下拉选择（如 llm、image_tools）。
 * provider 选项来自系统模型 Provider 配置；model 选项来自所选 Provider 的模型列表。
 * llm 组的 provider_type 由所选 Provider 自动带出；其余组保持原样（可选消歧）。
 * 图片理解组（视觉辅助）只列出支持视觉的 provider。
 */
function enrichSchemaWithProviderSelection(schema, config = configData.value) {
  // Schema data is held by a Vue ref and may contain reactive proxies, which
  // structuredClone cannot clone in the browser.
  const next = JSON.parse(JSON.stringify(schema || { groups: [] }));
  for (const group of next.groups || []) {
    const groupConfig = config?.[group.key];
    if (!groupConfig || typeof groupConfig !== 'object' || Array.isArray(groupConfig)) continue;
    const fields = group.fields || [];
    const hasProviderField = fields.some((field) => field.key === 'provider');
    const hasModelField = fields.some((field) => field.key === 'model_name');
    if (!hasProviderField && !hasModelField) continue;

    const currentProvider = String(groupConfig.provider || '').trim();
    const currentModel = String(groupConfig.model_name || '').trim();
    // 视觉辅助组只提供支持视觉的 provider；llm 主模型组保留全部（主模型可为非视觉）。
    const visionOnly = group.key === 'image_tools';
    const providerOptions = providers.value
      .filter((provider) => !visionOnly || provider.supports_vision === true)
      .map((provider) => ({
        value: provider.name || provider.key || '',
        label: `${provider.name || provider.key || '未命名'}${provider.provider_type ? ` (${provider.provider_type})` : ''}`,
      }))
      .filter((option) => option.value);
    if (currentProvider && !providerOptions.some((option) => option.value === currentProvider)) {
      providerOptions.unshift({ value: currentProvider, label: `${currentProvider} (当前配置)` });
    }
    const selectedProvider = findSelectedProvider(groupConfig);
    const modelOptions = getProviderModels(selectedProvider).map((model) => ({ value: model, label: model }));
    if (currentModel && !modelOptions.some((option) => option.value === currentModel)) {
      modelOptions.unshift({ value: currentModel, label: `${currentModel} (当前配置)` });
    }

    for (const field of fields) {
      if (field.key === 'provider') {
        field.type = 'select';
        field.options = [{ value: '', label: '未设置' }, ...providerOptions];
      } else if (field.key === 'model_name') {
        field.type = 'select';
        field.options = [{ value: '', label: '选择模型' }, ...modelOptions];
      } else if (field.key === 'provider_type' && PROVIDER_SELECT_GROUPS.includes(group.key)) {
        field.type = 'text';
        field.disabled = true;
        field.placeholder = '未设置';
        field.help = '由所选 Provider 自动带出';
      }
    }
  }
  return next;
}

function applyProviderToGroup(groupKey, groupConfig, selected) {
  if (groupKey === 'llm') return applyProviderToLlm(groupConfig, selected);
  // 其余组（image_tools）：带出 provider 与 provider_type，并清空 model_name——
  // 模型列表随 Provider 变化，沿用旧模型名会造成 "Provider A + 模型 B" 的静默错误配置。
  return {
    ...groupConfig,
    provider: selected.name || selected.key || '',
    provider_type: selected.provider_type || '',
    model_name: '',
  };
}

function handleConfigChange(nextConfig) {
  for (const groupKey of PROVIDER_SELECT_GROUPS) {
    const previousProvider = configData.value?.[groupKey]?.provider;
    const nextProvider = nextConfig?.[groupKey]?.provider;
    if (!nextProvider) {
      // 清空 provider 时重置该组关联字段
      nextConfig = {
        ...nextConfig,
        [groupKey]: { ...nextConfig[groupKey], provider: '', provider_type: '', model_name: '' },
      };
      continue;
    }
    if (nextProvider === previousProvider) continue;
    const selected = providers.value.find((item) => item?.name === nextProvider || item?.key === nextProvider);
    if (selected) {
      nextConfig = { ...nextConfig, [groupKey]: applyProviderToGroup(groupKey, nextConfig[groupKey], selected) };
    }
  }
  configData.value = nextConfig;
}

function addExtraParam() {
  extraParamEntries.value.push(createExtraParamEntry());
}

function removeExtraParam(index) {
  extraParamEntries.value.splice(index, 1);
}

async function handleSave() {
  saving.value = true;
  try {
    const payload = {
      ...configData.value,
      llm: {
        ...configData.value.llm,
        extra_params: parseExtraParamsInput(extraParamEntries.value, '系统 LLM '),
      },
    };
    const updated = await updateSystemConfig(payload);
    configData.value = updated;
    extraParamEntries.value = parseExtraParamEntries(updated?.llm?.extra_params);
    showToast('系统配置已保存', 'success');
  } catch (e) {
    showToast(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function handleReload() {
  try {
    await reloadSystemConfig();
    await loadData();
    showToast('配置已重新加载', 'success');
  } catch (e) {
    showToast(e.message || '重新加载失败');
  }
}

onMounted(loadData);
</script>

<style scoped>
.config-form {
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
}

.extra-param-editor {
  padding-top: var(--spacing-sm);
  margin-top: var(--spacing-sm);
  border-top: 1px dashed var(--color-border);
}

.extra-param-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.extra-param-row {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) 140px minmax(0, 1.8fr) auto;
  gap: var(--spacing-sm);
  align-items: center;
}

.extra-param-delete-button {
  justify-self: end;
}

.state-panel--compact {
  margin: 0;
  padding: var(--spacing-md);
}

.extra-param-content > .state-panel--compact {
  min-height: var(--control-height-md);
  padding: 0;
}

@media (max-width: 900px) {
  .extra-param-content > .state-panel--compact {
    min-height: calc(var(--control-height-md) * 2 + var(--spacing-sm));
  }

  .extra-param-row {
    grid-template-columns: minmax(0, 1fr) 110px minmax(0, 1fr);
    grid-template-areas:
      'key type value'
      'delete delete delete';
    align-items: stretch;
  }

  .extra-param-row > :nth-child(1) { grid-area: key; }
  .extra-param-row > :nth-child(2) { grid-area: type; }
  .extra-param-row > :nth-child(3) { grid-area: value; }
  .extra-param-row > :nth-child(4) {
    grid-area: delete;
    display: inline-flex;
    justify-self: end;
    width: auto;
    min-width: 0;
  }
}
</style>
