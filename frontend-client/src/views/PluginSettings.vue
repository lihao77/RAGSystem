<template>
  <PageLayout title="插件管理" subtitle="已安装插件的配置">
    <template #header-actions>
      <span v-if="isDirty" class="unsaved-hint">未保存</span>
      <Button variant="ghost" size="icon-sm" :disabled="loading || saving" aria-label="重新加载" :title="isDirty ? '重新加载（将丢弃未保存的修改）' : '重新加载'" @click="loadData">
        <IconRefresh :size="16" />
      </Button>
      <Button variant="ghost" size="icon-sm" :disabled="loading || saving || !isDirty" :aria-label="saving ? '保存中' : '保存配置'" :title="saving ? '保存中' : isDirty ? '保存有修改的插件配置' : '无待保存修改'" @click="handleSave">
        <IconSave :size="16" :class="{ 'save-icon--dirty': isDirty }" />
      </Button>
    </template>

    <EntityListLayout
      v-if="loading || loadError"
      title="已安装插件"
      description="查看后端已装配的插件并配置插件提供的设置项。"
      :loading="loading"
      loading-text="加载插件清单..."
      :error="loadError"
      @retry="loadData"
    />

    <div v-else-if="configurablePlugins.length === 0" class="plugin-empty">
      <p>当前没有声明配置项的插件。</p>
      <small>已安装 {{ installed.length }} 个插件；插件通过 systemConfig 扩展声明配置后在此出现。</small>
    </div>

    <div v-else class="plugin-settings-list">
      <section v-for="plugin in configurablePlugins" :key="plugin.id" class="plugin-settings-item">
        <header class="plugin-settings-head">
          <h3 class="plugin-name">{{ plugin.id }}</h3>
          <div class="plugin-meta">
            <span class="plugin-version">v{{ plugin.version }}</span>
            <span v-if="dirtyPlugins.has(plugin.id)" class="plugin-dirty">未保存</span>
            <span v-if="plugin.ui" class="plugin-has-ui">提供界面</span>
          </div>
        </header>
        <SchemaForm
          :model-value="configData"
          :schema="{ groups: plugin.groups }"
          @update:model-value="handleConfigChange"
        />
      </section>
    </div>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';

import PageLayout from '../components/PageLayout.vue';
import IconRefresh from '../components/icons/IconRefresh.vue';
import IconSave from '../components/icons/IconSave.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import SchemaForm from '../components/SchemaForm.vue';
import { Button } from '../components/ui/button/index.ts';
import { showToast } from '../composables/useToast.js';
import { useProviderSchemaEnrich } from '../composables/useProviderSchemaEnrich.js';
import { getProviders } from '../api/modelAdapter.js';
import { getSystemConfigSchema, getSystemConfig, updateSystemConfig } from '../api/systemConfig.js';
import { getInstalledPlugins } from '../api/plugins.js';

/**
 * 插件设置页：列出声明了 systemConfig 扩展组的插件（后端 /api/plugins 的
 * configGroups + /api/system-config/schema 的 sourceExtension 分组），
 * 复用 SchemaForm 渲染（含 provider/model 下拉增强）；保存按"有改动的
 * 插件"粒度 PATCH system-config。系统配置页只显示内置组，插件组仅在此页出现。
 */
const loading = ref(true);
const loadError = ref('');
const saving = ref(false);
const installed = ref([]);
const configData = ref({});
const schemaGroups = ref([]);
const providers = ref([]);
const { enrichSchemaWithProviderSelection, applyProviderCascade } = useProviderSchemaEnrich(providers);

// 每插件快照（脏检查）：{ [pluginId]: JSON.stringify(该插件各组当前值) }
const savedSnapshots = ref({});

const configurablePlugins = computed(() => installed.value
  .filter((plugin) => (plugin.configGroups ?? []).length > 0)
  .map((plugin) => {
    const groups = schemaGroups.value.filter((group) => plugin.configGroups.includes(group.key));
    return { ...plugin, groups: enrichSchemaWithProviderSelection({ groups }, configData.value).groups };
  }));

const dirtyPlugins = computed(() => {
  const dirty = new Set();
  for (const plugin of configurablePlugins.value) {
    const current = JSON.stringify(plugin.groups.map((group) => configData.value?.[group.key] ?? null));
    if (savedSnapshots.value[plugin.id] !== undefined && current !== savedSnapshots.value[plugin.id]) {
      dirty.add(plugin.id);
    }
  }
  return dirty;
});

const isDirty = computed(() => dirtyPlugins.value.size > 0);

async function loadData() {
  loading.value = true;
  loadError.value = '';
  try {
    const [plugins, schema, config, providerResult] = await Promise.all([
      getInstalledPlugins(),
      getSystemConfigSchema(),
      getSystemConfig(),
      getProviders().catch(() => []),
    ]);
    installed.value = plugins;
    schemaGroups.value = schema?.groups ?? [];
    configData.value = config ?? {};
    providers.value = Array.isArray(providerResult) ? providerResult : [];
    takeSnapshots();
  } catch (e) {
    loadError.value = e.message || '加载插件清单失败';
  } finally {
    loading.value = false;
  }
}

function takeSnapshots() {
  const next = {};
  for (const plugin of configurablePlugins.value) {
    next[plugin.id] = JSON.stringify(plugin.groups.map((group) => configData.value?.[group.key] ?? null));
  }
  savedSnapshots.value = next;
}

function handleConfigChange(nextConfig) {
  // 级联只作用于本页渲染的插件组（带 sourceExtension 标记）
  const pluginSchema = { groups: schemaGroups.value.filter((group) => group.sourceExtension) };
  configData.value = applyProviderCascade(configData.value, nextConfig, pluginSchema);
}

async function handleSave() {
  if (dirtyPlugins.value.size === 0) return;
  saving.value = true;
  try {
    // 只 PATCH 有改动的插件的组，保持最小载荷，避免覆盖其他插件的未保存修改
    const payload = {};
    for (const plugin of configurablePlugins.value) {
      if (!dirtyPlugins.value.has(plugin.id)) continue;
      for (const group of plugin.groups) {
        payload[group.key] = configData.value?.[group.key] ?? {};
      }
    }
    await updateSystemConfig(payload);
    takeSnapshots();
    showToast('插件配置已保存', 'success');
  } catch (e) {
    showToast(e.message || '保存失败');
  } finally {
    saving.value = false;
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

.plugin-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xl);
  color: var(--color-text-secondary);
}

.plugin-settings-list {
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

.plugin-settings-item {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  background: var(--color-surface);
}

.plugin-settings-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-md);
}

.plugin-name {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--color-text-primary);
  word-break: break-all;
}

.plugin-meta {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.plugin-dirty {
  color: var(--color-warning);
  font-weight: 600;
}

.plugin-has-ui {
  padding: 1px 8px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
}
</style>
