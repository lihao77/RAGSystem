<template>
  <PageLayout title="系统配置" subtitle="向量存储与系统运行参数">
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
      description="加载向量存储与系统运行参数。"
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

  </PageLayout>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import PageLayout from '../components/PageLayout.vue';
import IconRefresh from '../components/icons/IconRefresh.vue';
import IconSave from '../components/icons/IconSave.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import SchemaForm from '../components/SchemaForm.vue';
import { Button } from '../components/ui/button';
import { useToast } from '../composables/useToast.js';
import { showToast as showToastMessage } from '../utils/toast.js';
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
const toast = useToast();

const showToast = (message, type = 'error') => showToastMessage(toast, message, type);

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
