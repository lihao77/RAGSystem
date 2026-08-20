<template>
  <PageLayout title="系统配置" subtitle="系统模型与运行参数">
    <template #header-actions>
      <span v-if="isDirty" class="unsaved-hint">未保存</span>
      <Button variant="ghost" size="icon-sm" :disabled="loading || saving" aria-label="重新加载" :title="isDirty ? '重新加载（将丢弃未保存的修改）' : '重新加载'" @click="handleReload">
        <IconRefresh :size="16" />
      </Button>
      <Button variant="ghost" size="icon-sm" :disabled="loading || saving" :aria-label="saving ? '保存中' : '保存配置'" :title="saving ? '保存中' : isDirty ? '保存配置（有未保存修改）' : '保存配置'" @click="handleSave">
        <IconSave :size="16" :class="{ 'save-icon--dirty': isDirty }" />
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
      description="加载系统模型与运行参数。"
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
                    <Button type="button" variant="ghost" size="icon-sm" class="extra-param-delete-button" aria-label="删除该参数" title="删除该参数" @click="removeExtraParam(index)">
                      <IconTrash :size="14" />
                    </Button>
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
import IconTrash from '../components/icons/IconTrash.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import SchemaForm from '../components/SchemaForm.vue';
import { getProviders } from '../api/modelAdapter.js';
import CustomSelect from '../components/ui/CustomSelect.vue';
import { Input } from '../components/ui/input';
import {
  createExtraParamEntry,
  parseExtraParamEntries,
  parseExtraParamsInput,
} from '../utils/modelList.js';
import { Button } from '../components/ui/button';
import { showToast } from '../composables/useToast.js';
import { useConfirm } from '../composables/useConfirm.js';
import { useProviderSchemaEnrich } from '../composables/useProviderSchemaEnrich.js';
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
const { confirm } = useConfirm();
const { enrichSchemaWithProviderSelection, applyProviderCascade } = useProviderSchemaEnrich(providers);

// 插件贡献的组（带 sourceExtension 标记）归插件管理页显示，此处只渲染系统内置组
const builtinConfigSchema = computed(() => ({
  ...baseConfigSchema.value,
  groups: (baseConfigSchema.value.groups ?? []).filter((group) => !group.sourceExtension),
}));
const configSchema = computed(() => enrichSchemaWithProviderSelection(builtinConfigSchema.value, configData.value));

// 脏检查：加载/保存成功后打快照，表单或额外参数有改动即标记未保存
const savedSnapshot = ref('');
function takeSnapshot() {
  savedSnapshot.value = JSON.stringify([configData.value, extraParamEntries.value]);
}
const isDirty = computed(() => Boolean(savedSnapshot.value)
  && JSON.stringify([configData.value, extraParamEntries.value]) !== savedSnapshot.value);


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
    takeSnapshot();
  } catch (e) {
    error.value = e.message || '加载配置失败';
  } finally {
    loading.value = false;
  }
}

function handleConfigChange(nextConfig) {
  configData.value = applyProviderCascade(configData.value, nextConfig, builtinConfigSchema.value);
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
    takeSnapshot();
    showToast('系统配置已保存', 'success');
  } catch (e) {
    showToast(e.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function handleReload() {
  if (isDirty.value) {
    const ok = await confirm({
      message: '当前有未保存的配置修改，重新加载将丢弃这些修改。',
      confirmText: '丢弃并重新加载',
      danger: true,
    });
    if (!ok) return;
  }
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
.unsaved-hint {
  align-self: center;
  color: var(--color-warning);
  font-size: var(--font-size-xs);
  font-weight: 600;
  white-space: nowrap;
}

.save-icon--dirty {
  color: var(--color-warning);
}

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
