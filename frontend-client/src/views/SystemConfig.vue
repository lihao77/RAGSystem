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
import { useToast } from '../composables/useToast.js';
import { showToast as showToastMessage } from '../utils/toast.js';
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
const toast = useToast();
const configSchema = computed(() => enrichLlmSchema(baseConfigSchema.value, configData.value));

const showToast = (message, type = 'error') => showToastMessage(toast, message, type);

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

function findSelectedProvider(config = configData.value) {
  const providerName = String(config?.llm?.provider || '').trim();
  const providerType = String(config?.llm?.provider_type || '').trim();
  if (!providerName) return null;
  return providers.value.find((provider) => {
    const identifiers = [provider?.name, provider?.key].map((value) => String(value || '').trim());
    return identifiers.includes(providerName)
      && (!providerType || String(provider?.provider_type || '').trim() === providerType);
  }) || null;
}

function enrichLlmSchema(schema, config = configData.value) {
  // Schema data is held by a Vue ref and may contain reactive proxies, which
  // structuredClone cannot clone in the browser.
  const next = JSON.parse(JSON.stringify(schema || { groups: [] }));
  const group = next.groups?.find((item) => item.key === 'llm');
  if (!group) return next;

  const currentProvider = String(config?.llm?.provider || '').trim();
  const currentModel = String(config?.llm?.model_name || '').trim();
  const providerOptions = providers.value.map((provider) => ({
    value: provider.name || provider.key || '',
    label: `${provider.name || provider.key || '未命名'}${provider.provider_type ? ` (${provider.provider_type})` : ''}`,
  })).filter((option) => option.value);
  if (currentProvider && !providerOptions.some((option) => option.value === currentProvider)) {
    providerOptions.unshift({ value: currentProvider, label: `${currentProvider} (当前配置)` });
  }
  const selectedProvider = findSelectedProvider(config);
  const modelOptions = getProviderModels(selectedProvider).map((model) => ({ value: model, label: model }));
  if (currentModel && !modelOptions.some((option) => option.value === currentModel)) {
    modelOptions.unshift({ value: currentModel, label: `${currentModel} (当前配置)` });
  }

  for (const field of group.fields || []) {
    if (field.key === 'provider') {
      field.type = 'select';
      field.options = [{ value: '', label: '未设置' }, ...providerOptions];
    } else if (field.key === 'provider_type') {
      field.type = 'text';
      field.disabled = true;
      field.placeholder = '未设置';
      field.help = '由所选 Provider 自动带出';
    } else if (field.key === 'model_name') {
      field.type = 'select';
      field.options = [{ value: '', label: '选择模型' }, ...modelOptions];
    }
  }
  return next;
}

function handleConfigChange(nextConfig) {
  const previousProvider = configData.value?.llm?.provider;
  const nextProvider = nextConfig?.llm?.provider;
  if (!nextProvider) {
    configData.value = {
      ...nextConfig,
      llm: { ...nextConfig.llm, provider: '', provider_type: '', model_name: '' },
    };
    return;
  }
  if (nextProvider === previousProvider) {
    configData.value = nextConfig;
    return;
  }

  const selected = providers.value.find((item) => item?.name === nextProvider || item?.key === nextProvider);
  configData.value = selected
    ? {
        ...nextConfig,
        llm: applyProviderToLlm(nextConfig.llm, selected),
      }
    : nextConfig;
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
