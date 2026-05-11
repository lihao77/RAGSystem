<template>
  <PageLayout title="系统配置" subtitle="管理全局 LLM、向量存储、反思机制等系统级参数">
    <template #header-actions>
      <button class="adm-button pl-btn pl-btn--ghost" :disabled="loading || saving" @click="handleReload">
        重新加载
      </button>
      <button class="adm-button adm-button--primary pl-btn pl-btn--primary" :disabled="loading || saving" @click="handleSave">
        {{ saving ? '保存中...' : '保存配置' }}
      </button>
    </template>

    <EntityListLayout
      v-if="loading || error"
      title="系统配置数据"
      description="加载全局 LLM、向量存储、反思机制等系统级参数。"
      :loading="loading"
      loading-text="加载系统配置..."
      :error="error"
      @retry="loadData"
    />

    <template v-else>
      <div class="config-form">
        <SchemaForm v-model="configData" :schema="configSchema" />
      </div>
    </template>

    <AppToast ref="toastRef" />
  </PageLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import PageLayout from '../components/PageLayout.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import SchemaForm from '../components/SchemaForm.vue';
import AppToast from '../components/AppToast.vue';
import {
  getSystemConfigSchema,
  getSystemConfig,
  updateSystemConfig,
  reloadSystemConfig,
} from '../api/systemConfig.js';

const configSchema = ref({ groups: [] });
const configData = ref({});
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const toastRef = ref(null);

function showToast(message, type = 'error') {
  toastRef.value?.show(message, type);
}

async function loadData() {
  loading.value = true;
  error.value = '';
  try {
    const [schema, config] = await Promise.all([
      getSystemConfigSchema(),
      getSystemConfig(),
    ]);
    configSchema.value = schema;
    configData.value = config;
  } catch (e) {
    error.value = e.message || '加载配置失败';
  } finally {
    loading.value = false;
  }
}

async function handleSave() {
  saving.value = true;
  try {
    const updated = await updateSystemConfig(configData.value);
    configData.value = updated;
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
</style>
