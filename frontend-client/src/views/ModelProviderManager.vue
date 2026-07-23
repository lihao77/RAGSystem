<template>
  <PageLayout
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    mobile-content-padding="var(--spacing-sm)"
    title="模型 Provider 管理"
    subtitle="Provider 接入与连通性测试"
    mobile-title="Provider 管理"
  >
    <template #header-actions>
      <Button variant="ghost" size="icon-sm" aria-label="添加 Provider" title="添加 Provider" @click="openCreateDialog">
        <IconPlus />
      </Button>
      <Button variant="ghost" size="icon-sm" :disabled="loading" :aria-label="loading ? '刷新中' : '刷新'" :title="loading ? '刷新中' : '刷新'" @click="loadProviders">
        <IconRefresh :class="{ spin: loading }" />
      </Button>
    </template>

    <template #mobile-menu="{ close }">
      <button class="pl-menu-item" @click="openCreateDialog(); close()">
        <IconPlus />
        添加 Provider
      </button>
      <button class="pl-menu-item" :disabled="loading" @click="loadProviders(); close()">
        <IconRefresh :class="{ spin: loading }" />
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </template>

    <div class="provider-summary-bar" aria-live="polite">
      <span class="provider-summary-label">运行概览</span>
      <Badge variant="secondary">{{ providers.length }} 个 Provider</Badge>
      <Badge variant="success">{{ readyProviderCount }} 个配置就绪</Badge>
      <Badge v-if="issueProviderCount > 0" variant="warning">{{ issueProviderCount }} 个待完善</Badge>
      <Badge v-if="successfulTestCount > 0" variant="outline">{{ successfulTestCount }} 个已通过真实测试</Badge>
    </div>

    <EntityListLayout
      class="provider-list-section"
      title="Provider 列表"
      description="按优先级管理模型接入实例，并检查密钥、模型映射与真实调用状态。"
      :loading="loading && providers.length === 0"
      loading-text="加载中..."
      :error="error"
      :empty="providers.length === 0"
      empty-title="暂无 Provider"
      empty-hint="点击右上角“添加 Provider”开始配置"
      @retry="loadProviders"
    >
      <template #actions>
        <div class="inline-actions">
          <span v-if="reordering" class="reorder-status">正在保存排序...</span>
          <span v-else-if="reorderError" class="reorder-status reorder-status--error">{{ reorderError }}</span>
          <span v-else class="reorder-status">拖拽或使用方向键调整优先级</span>
        </div>
      </template>
      <template #empty-icon>
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
      </template>

      <div class="provider-toolbar">
        <Input v-model="searchQuery" aria-label="搜索 Provider" placeholder="搜索名称、类型、Endpoint 或模型" />
        <CustomSelect v-model="typeFilter" :options="providerFilterOptions" placeholder="全部类型" />
        <span class="provider-filter-count">显示 {{ filteredProviders.length }} / {{ providers.length }}</span>
      </div>

      <div v-if="filteredProviders.length === 0" class="provider-filter-empty">
        没有符合当前筛选条件的 Provider
      </div>

      <TransitionGroup v-else name="provider-row-list" tag="div" class="provider-list adm-entity-list">
        <article
          v-for="provider in filteredProviders"
          :key="getProviderKey(provider)"
          class="provider-row adm-entity-row"
          :class="{ 'provider-row--dragging': draggingKey === getProviderKey(provider) }"
          :data-provider-key="getProviderKey(provider)"
        >
          <div class="provider-row-main">
            <button
              type="button"
              class="drag-handle"
              :aria-label="`调整 ${provider.name || provider.key} 的优先级，当前位置 ${providerOrder(provider)}`"
              title="拖拽调整优先级；聚焦后可使用上下方向键"
              :disabled="reordering"
              @pointerdown="startProviderDrag($event, provider)"
              @keydown.up.prevent="moveProviderByKeyboard(provider, -1)"
              @keydown.down.prevent="moveProviderByKeyboard(provider, 1)"
            >
              <span class="order-index">{{ providerOrder(provider) }}</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
            </button>

            <div class="provider-identity" :title="getProviderKey(provider)">
              <div class="provider-title-line">
                <strong class="provider-name">{{ provider.name || provider.key }}</strong>
                <span class="provider-title-divider" aria-hidden="true"></span>
                <span class="provider-type-text">{{ provider.provider_type || 'custom' }}</span>
              </div>
              <div class="provider-status-line">
                <Badge :variant="providerStatus(provider).variant" :title="providerStatus(provider).detail">
                  {{ providerStatus(provider).label }}
                </Badge>
                <Badge :variant="provider.api_key_configured ? 'secondary' : 'destructive'">
                  {{ provider.api_key_configured ? 'Key 已配置' : '缺少 Key' }}
                </Badge>
                <span class="provider-endpoint mono" :title="provider.api_endpoint || ''">{{ provider.api_endpoint || '使用默认 Endpoint' }}</span>
              </div>
              <div class="provider-models" :aria-label="`${provider.name || provider.key} 的模型映射`">
                <Badge v-for="entry in visibleModelEntries(provider)" :key="`${entry.task}:${entry.model}`" variant="outline">
                  {{ entry.task }} · {{ entry.model }}
                </Badge>
                <span v-if="providerModelEntries(provider).length === 0" class="provider-models-empty">未配置模型映射</span>
                <Badge v-else-if="hiddenModelCount(provider) > 0" variant="secondary">+{{ hiddenModelCount(provider) }}</Badge>
              </div>
            </div>

            <div class="provider-row-actions">
              <Button variant="action-success" size="action" :disabled="isTesting(provider)" @click="quickTest(provider)">
                <IconRefresh v-if="isTesting(provider)" data-icon="inline-start" class="spin" />
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                {{ isTesting(provider) ? '测试中' : '真实测试' }}
              </Button>
              <Button variant="action-neutral" size="action" @click="openEditDialog(provider)">
                <IconEdit data-icon="inline-start" />
                编辑
              </Button>
              <Button variant="action-danger" size="action" @click="confirmDelete(provider)">
                <IconTrash data-icon="inline-start" />
                删除
              </Button>
            </div>
          </div>

          <div v-if="testResults[getProviderKey(provider)]" class="provider-test-result" :class="testResults[getProviderKey(provider)].ok ? 'result--ok' : 'result--err'">
            <span class="result-icon"><IconCheck v-if="testResults[getProviderKey(provider)].ok" /><IconClose v-else /></span>
            <span class="result-msg">
              <strong>{{ testResults[getProviderKey(provider)].task }} · {{ testResults[getProviderKey(provider)].model }}</strong>
              {{ testResults[getProviderKey(provider)].msg }}
            </span>
          </div>
        </article>
      </TransitionGroup>
    </EntityListLayout>

    <Dialog :open="dialog.visible" @update:open="(v) => { if (!v) closeDialog() }">
      <DialogContent class="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>{{ dialog.mode === 'create' ? '添加 Provider' : '编辑 Provider' }}</DialogTitle>
          <DialogDescription>
            {{ dialog.mode === 'create' ? '配置接入信息、运行参数和任务模型映射。' : `更新 ${editingKey} 的接入配置；API Key 留空时保持原值。` }}
          </DialogDescription>
        </DialogHeader>
        <div class="dialog-form">
        <section class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>基础配置</h3><p>填写 Provider 标识、鉴权信息与基础接入地址。</p></div>
          <FieldGroup class="dialog-form-grid form-grid">
            <Field v-if="dialog.mode === 'create'" :data-invalid="!!formErrors.name">
              <FieldLabel for="provider-name">名称 <span class="required">*</span></FieldLabel>
              <Input id="provider-name" v-model="form.name" :aria-invalid="!!formErrors.name" placeholder="例如：生产环境 OpenAI" />
              <FieldDescription>保存后生成 Key：<span class="mono">{{ providerKeyPreview || '填写名称并选择类型后显示' }}</span></FieldDescription>
              <FieldError v-if="formErrors.name">{{ formErrors.name }}</FieldError>
            </Field>
            <Field v-if="dialog.mode === 'create'" :data-invalid="!!formErrors.provider_type">
              <FieldLabel>Provider 类型 <span class="required">*</span></FieldLabel>
              <CustomSelect :model-value="form.provider_type" :options="providerTypeOptions" placeholder="-- 请选择 --" @update:model-value="handleProviderTypeChange" />
              <FieldError v-if="formErrors.provider_type">{{ formErrors.provider_type }}</FieldError>
            </Field>
            <Field class="dialog-form-grid__full form-grid__full" :data-invalid="!!formErrors.api_key">
              <FieldLabel for="provider-api-key">API Key <span v-if="dialog.mode === 'create'" class="required">*</span></FieldLabel>
              <Input id="provider-api-key" v-model="form.api_key" type="password" :aria-invalid="!!formErrors.api_key" :placeholder="dialog.mode === 'create' ? 'sk-... 或 ${ENV_VAR}' : '留空则保持当前 API Key'" autocomplete="new-password" />
              <FieldDescription>{{ dialog.mode === 'create' ? '支持 ${ENV_VAR} 形式引用环境变量；列表接口不会回传明文。' : '仅在需要替换密钥时填写；留空表示保持当前值。' }}</FieldDescription>
              <FieldError v-if="formErrors.api_key">{{ formErrors.api_key }}</FieldError>
            </Field>
            <Field class="dialog-form-grid__full form-grid__full" :data-invalid="!!formErrors.api_endpoint">
              <FieldLabel for="provider-api-endpoint">API Endpoint</FieldLabel>
              <Input id="provider-api-endpoint" v-model="form.api_endpoint" :aria-invalid="!!formErrors.api_endpoint" :placeholder="apiEndpointPlaceholder" />
              <FieldDescription>留空时使用该 Provider 类型的默认 Endpoint。</FieldDescription>
              <FieldError v-if="formErrors.api_endpoint">{{ formErrors.api_endpoint }}</FieldError>
            </Field>
          </FieldGroup>
        </section>

        <section v-if="form.provider_type !== 'rerank_api'" class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>运行参数</h3><p>配置温度、token 上限与超时时间等运行时参数。</p></div>
          <FieldGroup class="dialog-form-grid form-grid">
            <Field><FieldLabel for="provider-temperature">温度</FieldLabel><Input id="provider-temperature" v-model.number="form.temperature" type="number" step="0.1" min="0" max="2" placeholder="0.7" /></Field>
            <Field><FieldLabel for="provider-completion-tokens">Max Completion Tokens</FieldLabel><Input id="provider-completion-tokens" v-model.number="form.max_completion_tokens" type="number" step="256" min="256" placeholder="4096" /></Field>
            <Field><FieldLabel for="provider-context-tokens">Max Context Tokens</FieldLabel><Input id="provider-context-tokens" v-model.number="form.max_context_tokens" type="number" step="1024" min="1024" placeholder="128000" /></Field>
            <Field><FieldLabel for="provider-timeout">Timeout (s)</FieldLabel><Input id="provider-timeout" v-model.number="form.timeout" type="number" step="5" min="5" placeholder="60" /></Field>
          </FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">模型能力</FieldLegend>
            <FieldGroup class="capability-fields">
              <Field orientation="horizontal">
                <FieldLabel>
                  <Switch v-model:checked="form.supports_function_calling" />
                  <FieldContent><FieldTitle>原生 Function Calling</FieldTitle><FieldDescription>OpenAI 兼容模型启用厂商原生工具调用；Anthropic 自动使用 tool_use。</FieldDescription></FieldContent>
                </FieldLabel>
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>
                  <Switch v-model:checked="form.supports_vision" />
                  <FieldContent><FieldTitle>图片输入（Vision）</FieldTitle><FieldDescription>标记此 Provider 的 Chat 模型能够识别图片。</FieldDescription></FieldContent>
                </FieldLabel>
              </Field>
            </FieldGroup>
          </FieldSet>
        </section>

        <section class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>模型与扩展</h3><p>管理 Provider 的扩展字段与任务模型映射。</p></div>
          <template v-if="activeProviderConfigFields.length > 0">
            <div class="form-section-title">Provider 扩展配置</div>
            <FieldGroup class="dialog-form-grid form-grid">
              <Field v-for="field in activeProviderConfigFields" :key="field.key" :orientation="field.type === 'boolean' ? 'horizontal' : 'vertical'">
                <FieldLabel v-if="field.type !== 'boolean'" :for="`provider-extra-${field.key}`">{{ field.label }}</FieldLabel>
                <template v-if="field.type === 'boolean'">
                  <FieldLabel>
                    <Switch v-model:checked="form[field.key]" />
                    <FieldContent><FieldTitle>{{ field.label }}</FieldTitle><FieldDescription v-if="field.help">{{ field.help }}</FieldDescription></FieldContent>
                  </FieldLabel>
                </template>
                <CustomSelect v-else-if="field.type === 'select'" :model-value="form[field.key] ?? ''" :options="field.options || []" :placeholder="field.placeholder || '-- 请选择 --'" @update:model-value="form[field.key] = $event" />
                <Input v-else-if="field.type === 'number'" :id="`provider-extra-${field.key}`" v-model.number="form[field.key]" type="number" :step="field.step || (field.key === 'retry_delay' ? 0.1 : 1)" :min="field.min" :max="field.max" :placeholder="field.placeholder || ''" />
                <Input v-else :id="`provider-extra-${field.key}`" v-model="form[field.key]" :type="field.type === 'password' ? 'password' : 'text'" :placeholder="field.placeholder || ''" />
                <FieldDescription v-if="field.help && field.type !== 'boolean'">{{ field.help }}</FieldDescription>
              </Field>
            </FieldGroup>
          </template>
          <FieldSet :data-invalid="!!formErrors.model_map">
            <FieldLegend variant="label">模型映射 (model_map)</FieldLegend>
            <FieldDescription>按 Chat、Embedding、Rerank 任务分别配置真实模型名；同一任务可添加多个模型。</FieldDescription>
            <div class="model-map-editor">
              <div v-for="(entry, idx) in modelMapEntries" :key="idx" class="model-map-row">
                <CustomSelect v-model="entry.task" :options="modelTaskOptions" placeholder="任务类型" />
                <span class="map-arrow"><IconChevronRight /></span>
                <Input v-model="entry.model" :aria-label="`${entry.task || '任务'} 模型名`" placeholder="例如：gpt-4.1" />
                <Button variant="ghost" size="icon" aria-label="删除映射" title="删除映射" :disabled="modelMapEntries.length === 1" @click="removeModelMapEntry(idx)">
                  <IconClose />
                </Button>
              </div>
              <Button variant="outline" class="w-full" @click="addModelMapEntry"><IconPlus data-icon="inline-start" />添加映射</Button>
              <FieldError v-if="formErrors.model_map">{{ formErrors.model_map }}</FieldError>
            </div>
          </FieldSet>
        </section>

        <FieldError v-if="dialog.error">{{ dialog.error }}</FieldError>
      </div>
      <DialogFooter class="provider-dialog-footer">
        <Button size="sm" variant="outline" :disabled="saving" @click="closeDialog">取消</Button>
        <Button class="provider-dialog-submit" size="sm" variant="default" :disabled="saving" @click="handleSubmit"><IconRefresh v-if="saving" data-icon="inline-start" class="spin" />{{ saving ? '保存中...' : '保存' }}</Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = null }">
      <DialogContent class="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>确认删除</DialogTitle>
          <DialogDescription>删除后，引用该 Provider 的 Agent 或知识库配置可能无法运行。</DialogDescription>
        </DialogHeader>
        <p class="delete-confirm-msg">确定要删除 Provider <strong>{{ deleteTarget ? getProviderKey(deleteTarget) : '' }}</strong> 吗？此操作不可撤销。</p>
        <p v-if="deleteUsageLoading" class="delete-usage-loading">正在检查引用关系...</p>
        <FieldError v-else-if="deleteUsageError">{{ deleteUsageError }}</FieldError>
        <div v-else-if="deleteUsages.length > 0" class="delete-usage-list">
          <strong>请先解除以下 {{ deleteUsages.length }} 个引用：</strong>
          <div v-for="usage in deleteUsages" :key="`${usage.kind}:${usage.key}:${usage.detail}`" class="delete-usage-item">
            <Badge variant="warning">{{ usageKindLabel(usage.kind) }}</Badge>
            <span>{{ usage.label }}</span>
            <small>{{ usage.detail }}</small>
          </div>
        </div>
        <DialogFooter>
        <Button size="sm" variant="outline" @click="deleteTarget = null">取消</Button>
        <Button size="sm" variant="destructive" :disabled="deleting || deleteUsageLoading || !!deleteUsageError || deleteUsages.length > 0" @click="doDelete">
          {{ deleting ? '删除中...' : deleteUsages.length > 0 ? '存在引用，无法删除' : '确认删除' }}
        </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </PageLayout>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { normalizeModelList } from '../utils/modelList.js';
import CustomSelect from '../components/ui/CustomSelect.vue';
import { Switch } from '../components/ui/switch';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import { Badge } from '../components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog';
import {
  Field, FieldContent, FieldDescription, FieldError, FieldGroup,
  FieldLabel, FieldLegend, FieldSet, FieldTitle,
} from '../components/ui/field';
import PageLayout from '../components/PageLayout.vue';
import IconRefresh from '../components/icons/IconRefresh.vue';
import IconClose from '../components/icons/IconClose.vue';
import IconCheck from '../components/icons/IconCheck.vue';
import IconChevronRight from '../components/icons/IconChevronRight.vue';
import IconPlus from '../components/icons/IconPlus.vue';
import IconTrash from '../components/icons/IconTrash.vue';
import IconEdit from '../components/icons/IconEdit.vue';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useToast } from '../composables/useToast.js';
import { useEntityList } from '../composables/useEntityList.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import {
  getProviderTypes, getProviders, createProvider, updateProvider,
  checkProviderAvailability, deleteProvider, getProviderUsages, reorderProviders, testProvider,
} from '../api/modelAdapter.js';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const toast = useToast();

const providerTypeMeta = ref({});
const providerTypeOptions = ref([]);

const COMMON_PROVIDER_FIELDS = [
  { key: 'retry_attempts', label: '重试次数', type: 'number', default: 2, help: '可重试错误发生后的最大重试次数。', options: [] },
  { key: 'retry_delay', label: '初始重试延迟 (s)', type: 'number', default: 0.5, help: '第一次重试前的等待时间。', options: [] },
  { key: 'retry_backoff_factor', label: '退避倍率', type: 'number', default: 2, help: '后续重试等待时间的指数退避倍率。', options: [] },
];
const OPENAI_REASONING_FIELD = {
  key: 'reasoning_effort', label: '推理强度', type: 'select', default: '', help: '仅对支持 reasoning_effort 的 OpenAI 推理模型生效。',
  options: [{ value: '', label: '模型默认' }, { value: 'none', label: 'None' }, { value: 'minimal', label: 'Minimal' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'XHigh' }],
};
const ANTHROPIC_FIELDS = [
  { key: 'thinking_budget_tokens', label: 'Thinking Budget Tokens', type: 'number', default: 0, help: 'Anthropic 扩展思考预算；0 表示使用模型默认行为。', options: [] },
  { key: 'supports_prompt_caching', label: '启用 Prompt Cache', type: 'boolean', default: true, help: '控制 Anthropic prompt cache 标记与缓存复用。', options: [] },
  { key: 'cache_ttl_seconds', label: 'Cache TTL (s)', type: 'number', default: 300, help: 'Provider KV cache 的滑动失效阈值。', options: [] },
];

function fallbackConfigFields(providerType) {
  const fields = [...COMMON_PROVIDER_FIELDS];
  if (providerType === 'openai_resp') fields.unshift(OPENAI_REASONING_FIELD);
  if (providerType === 'anthropic') fields.unshift(...ANTHROPIC_FIELDS);
  return fields;
}

const FALLBACK_PROVIDER_TYPES = [
  { value: 'openai_resp', label: 'OpenAI Responses', default_endpoint: 'https://api.openai.com/v1' },
  { value: 'openai_chat', label: 'OpenAI Chat', default_endpoint: 'https://api.openai.com/v1' },
  { value: 'openai_proxy', label: 'OpenAI Compatible', default_endpoint: 'https://api.openai.com/v1' },
  { value: 'anthropic', label: 'Anthropic', default_endpoint: 'https://api.anthropic.com' },
  { value: 'deepseek', label: 'DeepSeek', default_endpoint: 'https://api.deepseek.com/v1' },
  { value: 'openrouter', label: 'OpenRouter', default_endpoint: 'https://openrouter.ai/api/v1' },
  { value: 'modelscope', label: 'ModelScope', default_endpoint: 'https://api-inference.modelscope.cn/v1' },
  { value: 'rerank_api', label: 'Rerank API', default_endpoint: '' },
].map((item) => ({ ...item, config_fields: fallbackConfigFields(item.value) }));

async function loadProviderTypes() {
  try {
    const types = await getProviderTypes();
    providerTypeMeta.value = Object.fromEntries(types.map((t) => [t.value, { label: t.label, default_endpoint: t.default_endpoint || '', config_fields: t.config_fields || [] }]));
    providerTypeOptions.value = types.map((t) => ({ value: t.value, label: t.label }));
  } catch {
    providerTypeMeta.value = Object.fromEntries(FALLBACK_PROVIDER_TYPES.map((t) => [t.value, { label: t.label, default_endpoint: t.default_endpoint, config_fields: t.config_fields || [] }]));
    providerTypeOptions.value = FALLBACK_PROVIDER_TYPES.map((t) => ({ value: t.value, label: t.label }));
  }
}

const { items: providers, loading, error, refresh: fetchProviders } = useEntityList(getProviders, { errorPrefix: '加载失败', immediate: false });

const availabilityByKey = ref({});
const availabilityLoadingKeys = ref(new Set());
const testingKeys = ref(new Set());
const testResults = ref({});
const searchQuery = ref('');
const typeFilter = ref('');
const deleteTarget = ref(null);
const deleteUsages = ref([]);
const deleteUsageLoading = ref(false);
const deleteUsageError = ref('');
const draggingKey = ref('');
const dragOriginalProviders = ref(null);
const dragOrderChanged = ref(false);
let dragImageEl = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
const reordering = ref(false);
const reorderError = ref('');

const providerFilterOptions = computed(() => [
  { value: '', label: '全部类型' },
  ...providerTypeOptions.value,
]);
const filteredProviders = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  return providers.value.filter((provider) => {
    if (typeFilter.value && provider.provider_type !== typeFilter.value) return false;
    if (!query) return true;
    const modelText = providerModelEntries(provider).map((entry) => `${entry.task} ${entry.model}`).join(' ');
    return [provider.name, provider.key, provider.provider_type, provider.api_endpoint, modelText]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });
});
const readyProviderCount = computed(() => providers.value.filter((provider) => availabilityByKey.value[getProviderKey(provider)]?.is_available).length);
const issueProviderCount = computed(() => providers.value.filter((provider) => availabilityByKey.value[getProviderKey(provider)]?.is_available === false).length);
const successfulTestCount = computed(() => Object.values(testResults.value).filter((result) => result?.ok).length);

function getProviderKey(provider) { return provider.key || `${provider.name}_${provider.provider_type}`; }
function providerOrder(provider) { return providers.value.findIndex((item) => getProviderKey(item) === getProviderKey(provider)) + 1; }
function providerModelEntries(provider) {
  return Object.entries(provider.model_map || {}).flatMap(([task, value]) => normalizeModelList(value).map((model) => ({ task, model })));
}
function visibleModelEntries(provider) { return providerModelEntries(provider).slice(0, 5); }
function hiddenModelCount(provider) { return Math.max(0, providerModelEntries(provider).length - 5); }
function isTesting(provider) { return testingKeys.value.has(getProviderKey(provider)); }
function providerStatus(provider) {
  const key = getProviderKey(provider);
  if (availabilityLoadingKeys.value.has(key)) return { label: '检查中', detail: '正在检查配置完整性', variant: 'secondary' };
  const status = availabilityByKey.value[key];
  if (!status) return { label: '未检查', detail: '刷新页面以检查配置完整性', variant: 'outline' };
  return status.is_available
    ? { label: '配置就绪', detail: '密钥、Endpoint 和至少一个任务模型均已配置', variant: 'success' }
    : { label: '待完善', detail: status.error || 'Provider 配置不完整', variant: 'warning' };
}

async function loadProviderAvailability(items) {
  const keys = items.map(getProviderKey);
  availabilityLoadingKeys.value = new Set(keys);
  const entries = await Promise.all(items.map(async (provider) => {
    const key = getProviderKey(provider);
    try {
      return [key, await checkProviderAvailability(key)];
    } catch (e) {
      return [key, { is_available: false, error: e?.message || '配置检查失败', checks: {} }];
    }
  }));
  availabilityByKey.value = Object.fromEntries(entries);
  availabilityLoadingKeys.value = new Set();
}

async function loadProviders() {
  const items = await fetchProviders();
  if (items) await loadProviderAvailability(items);
  return items;
}
function isSameProviderOrder(left, right) {
  if (left.length !== right.length) return false;
  return left.every((p, i) => getProviderKey(p) === getProviderKey(right[i]));
}
function getDefaultModel(value) { return normalizeModelList(value)[0] || ''; }

async function persistProviderOrder(nextProviders, previousProviders, options = {}) {
  if (reordering.value) return;
  providers.value = nextProviders;
  reordering.value = true;
  reorderError.value = '';
  try {
    await reorderProviders(nextProviders.map(getProviderKey));
    if (!options.silent) toast.success('Provider 顺序已保存');
  } catch (e) {
    providers.value = previousProviders;
    const message = e?.message || '排序保存失败';
    reorderError.value = message;
    toast.error(message);
  } finally {
    reordering.value = false;
    if (!options.skipCleanup) cleanupProviderDrag();
  }
}

async function moveProviderByKeyboard(provider, offset) {
  if (reordering.value) return;
  const fromIndex = providers.value.findIndex((item) => getProviderKey(item) === getProviderKey(provider));
  const toIndex = fromIndex + offset;
  if (fromIndex < 0 || toIndex < 0 || toIndex >= providers.value.length) return;
  const previousProviders = [...providers.value];
  const nextProviders = [...providers.value];
  const [moved] = nextProviders.splice(fromIndex, 1);
  nextProviders.splice(toIndex, 0, moved);
  await persistProviderOrder(nextProviders, previousProviders);
}

function startProviderDrag(event, provider) {
  if (reordering.value || event.button !== 0) return;
  const row = event.currentTarget.closest('.provider-row');
  if (!row) return;
  event.preventDefault();
  row.setPointerCapture?.(event.pointerId);
  const rect = row.getBoundingClientRect();
  draggingKey.value = getProviderKey(provider);
  dragOriginalProviders.value = [...providers.value];
  dragOrderChanged.value = false;
  dragOffsetX = event.clientX - rect.left;
  dragOffsetY = event.clientY - rect.top;
  dragImageEl = row.cloneNode(true);
  dragImageEl.removeAttribute('data-provider-key');
  dragImageEl.classList.add('provider-row-drag-image');
  dragImageEl.style.width = `${rect.width}px`;
  dragImageEl.style.position = 'fixed';
  dragImageEl.style.left = `${event.clientX - dragOffsetX}px`;
  dragImageEl.style.top = `${event.clientY - dragOffsetY}px`;
  dragImageEl.style.zIndex = '2000';
  dragImageEl.style.pointerEvents = 'none';
  dragImageEl.style.transition = 'none';
  document.body.appendChild(dragImageEl);
  window.addEventListener('pointermove', handleProviderDragMove);
  window.addEventListener('pointerup', finishProviderDrag, { once: true });
  window.addEventListener('pointercancel', cancelProviderDrag, { once: true });
}
function handleProviderDragMove(event) {
  if (!draggingKey.value || !dragImageEl) return;
  dragImageEl.style.left = `${event.clientX - dragOffsetX}px`;
  dragImageEl.style.top = `${event.clientY - dragOffsetY}px`;
  const targetRow = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.provider-row');
  if (!targetRow) return;
  const toKey = targetRow.dataset.providerKey;
  const fromKey = draggingKey.value;
  if (!toKey || toKey === fromKey || reordering.value) return;
  const fromIndex = providers.value.findIndex((item) => getProviderKey(item) === fromKey);
  const toIndex = providers.value.findIndex((item) => getProviderKey(item) === toKey);
  if (fromIndex < 0 || toIndex < 0) return;
  const rect = targetRow.getBoundingClientRect();
  const insertAfter = event.clientY > rect.top + rect.height / 2;
  let targetIndex = insertAfter ? toIndex + 1 : toIndex;
  if (fromIndex < targetIndex) targetIndex -= 1;
  if (targetIndex === fromIndex) return;
  const nextProviders = [...providers.value];
  const [moved] = nextProviders.splice(fromIndex, 1);
  nextProviders.splice(targetIndex, 0, moved);
  providers.value = nextProviders;
  dragOrderChanged.value = true;
}
async function finishProviderDrag() {
  if (!draggingKey.value || reordering.value) { cleanupProviderDrag(); return; }
  const previousProviders = dragOriginalProviders.value ? [...dragOriginalProviders.value] : [...providers.value];
  const nextProviders = [...providers.value];
  if (!dragOrderChanged.value || isSameProviderOrder(previousProviders, nextProviders)) {
    providers.value = previousProviders;
    cleanupProviderDrag();
    return;
  }
  await animateDragImageToPlaceholder();
  hideDragImage();
  cleanupProviderDrag({ keepImage: true });
  await persistProviderOrder(nextProviders, previousProviders, { skipCleanup: true, silent: true });
}
async function animateDragImageToPlaceholder() {
  if (!dragImageEl || !draggingKey.value) return;
  const placeholder = Array.from(document.querySelectorAll('.provider-row')).find((row) => row !== dragImageEl && row.dataset.providerKey === draggingKey.value);
  if (!placeholder) return;
  const startRect = dragImageEl.getBoundingClientRect();
  const targetRect = placeholder.getBoundingClientRect();
  const deltaX = targetRect.left - startRect.left;
  const deltaY = targetRect.top - startRect.top;
  if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;
  dragImageEl.style.left = `${startRect.left}px`;
  dragImageEl.style.top = `${startRect.top}px`;
  dragImageEl.style.width = `${targetRect.width}px`;
  const animation = dragImageEl.animate([{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
  try { await animation.finished; } catch { /* cancelled */ }
  dragImageEl.style.left = `${targetRect.left}px`;
  dragImageEl.style.top = `${targetRect.top}px`;
  dragImageEl.style.transform = 'none';
}
function cancelProviderDrag() {
  if (dragOriginalProviders.value) providers.value = dragOriginalProviders.value;
  cleanupProviderDrag();
}
function hideDragImage() { if (dragImageEl) dragImageEl.style.visibility = 'hidden'; }
function cleanupProviderDrag(options = {}) {
  const imageToRemove = dragImageEl;
  draggingKey.value = '';
  dragOriginalProviders.value = null;
  dragOrderChanged.value = false;
  if (imageToRemove && !options.keepImage) imageToRemove.remove();
  else if (imageToRemove) requestAnimationFrame(() => imageToRemove.remove());
  dragImageEl = null;
  window.removeEventListener('pointermove', handleProviderDragMove);
  window.removeEventListener('pointerup', finishProviderDrag);
  window.removeEventListener('pointercancel', cancelProviderDrag);
}

function getPreferredTestTarget(provider) {
  const rerankModel = getDefaultModel(provider.model_map?.rerank);
  if ((provider.provider_type === 'rerank_api' || rerankModel) && rerankModel) return { task: 'rerank', model: rerankModel, prompt: '三级响应启动条件' };
  const chatModel = getDefaultModel(provider.model_map?.chat);
  if (chatModel) return { task: 'chat', model: chatModel, prompt: 'Hi' };
  const embeddingModel = getDefaultModel(provider.model_map?.embedding);
  if (embeddingModel) return { task: 'embedding', model: embeddingModel, prompt: '测试向量化' };
  return { task: 'chat', model: normalizeModelList(provider.models)[0] || '', prompt: 'Hi' };
}

async function quickTest(provider) {
  const key = getProviderKey(provider);
  if (testingKeys.value.has(key)) return;
  testingKeys.value = new Set([...testingKeys.value, key]);
  testResults.value = { ...testResults.value, [key]: null };
  const target = getPreferredTestTarget(provider);
  try {
    if (!target.model) throw new Error(`请先配置 ${target.task} 模型`);
    const result = await testProvider(key, target.model, target.prompt, provider.provider_type || '', target.task);
    if (result.error) throw new Error(result.error);
    const latency = Number(result.latency);
    const latencyText = Number.isFinite(latency) ? ` · ${latency.toFixed(2)}s` : '';
    let message = `响应：${String(result.content || '').slice(0, 80) || '调用成功'}${latencyText}`;
    if (target.task === 'embedding') message = `返回 ${result.embeddings?.[0]?.length || 0} 维向量${latencyText}`;
    else if (target.task === 'rerank') message = `返回 ${result.results?.length || 0} 条排序结果${latencyText}`;
    testResults.value = { ...testResults.value, [key]: { ok: true, msg: message, task: target.task, model: target.model } };
    toast.success(`${provider.name || key} 真实调用成功`);
  } catch (e) {
    const message = e?.message || '测试失败';
    testResults.value = { ...testResults.value, [key]: { ok: false, msg: message, task: target.task, model: target.model || '未配置' } };
    toast.error(message);
  } finally {
    const next = new Set(testingKeys.value);
    next.delete(key);
    testingKeys.value = next;
  }
}

const dialog = ref({ visible: false, mode: 'create', error: '' });
const editingKey = ref('');
const form = ref({});
const modelMapEntries = ref([]);
const formErrors = ref({});
const modelTaskOptions = [
  { value: 'chat', label: 'Chat' },
  { value: 'embedding', label: 'Embedding' },
  { value: 'rerank', label: 'Rerank' },
];

const apiEndpointPlaceholder = computed(() => {
  const providerType = form.value.provider_type;
  if (providerType === 'rerank_api') return '例如: https://api.jina.ai/v1/rerank';
  return providerTypeMeta.value[providerType]?.default_endpoint || '由后端返回默认 API Endpoint';
});
const activeProviderConfigFields = computed(() => providerTypeMeta.value[form.value.provider_type]?.config_fields || []);
const providerKeyPreview = computed(() => {
  const name = String(form.value.name || '').trim().toLowerCase().replace(/\s+/g, '_');
  const providerType = String(form.value.provider_type || '').trim().toLowerCase();
  return name && providerType ? `${name}_${providerType}` : '';
});

function buildFormDefaults() {
  return { name: '', provider_type: '', api_key: '', api_endpoint: '', temperature: 0.7, max_completion_tokens: 4096, max_context_tokens: 128000, timeout: 60, supports_function_calling: false, supports_vision: false };
}
function openCreateDialog() {
  form.value = buildFormDefaults();
  modelMapEntries.value = [{ task: 'chat', model: '' }];
  formErrors.value = {};
  dialog.value = { visible: true, mode: 'create', error: '' };
  editingKey.value = '';
}
function openEditDialog(provider) {
  const mm = provider.model_map || {};
  modelMapEntries.value = Object.entries(mm).flatMap(([task, value]) => {
    const models = normalizeModelList(value);
    return models.length ? models.map((model) => ({ task, model })) : [{ task, model: '' }];
  });
  if (modelMapEntries.value.length === 0) modelMapEntries.value = [{ task: 'chat', model: '' }];
  const nextForm = {
    provider_type: provider.provider_type || '', api_key: '', api_endpoint: provider.api_endpoint || '',
    temperature: provider.temperature ?? 0.7, max_completion_tokens: provider.max_completion_tokens || 4096,
    max_context_tokens: provider.max_context_tokens || 128000, timeout: provider.timeout || 60,
    supports_function_calling: provider.supports_function_calling ?? false, supports_vision: provider.supports_vision ?? false,
  };
  for (const field of getProviderConfigFields(nextForm.provider_type)) nextForm[field.key] = provider[field.key] ?? field.default ?? '';
  form.value = nextForm;
  formErrors.value = {};
  editingKey.value = getProviderKey(provider);
  dialog.value = { visible: true, mode: 'edit', error: '' };
}
function handleProviderTypeChange(providerType) {
  const previousType = form.value.provider_type;
  const previousDefault = providerTypeMeta.value[previousType]?.default_endpoint || '';
  const nextDefault = providerTypeMeta.value[providerType]?.default_endpoint || '';
  const previousFields = getProviderConfigFields(previousType);
  const nextFields = getProviderConfigFields(providerType);
  form.value.provider_type = providerType;
  formErrors.value = { ...formErrors.value, provider_type: '' };
  if (!form.value.api_endpoint || form.value.api_endpoint === previousDefault) form.value.api_endpoint = nextDefault;
  for (const field of previousFields) { if (!nextFields.some((item) => item.key === field.key)) delete form.value[field.key]; }
  for (const field of nextFields) {
    const prevDef = previousFields.find((item) => item.key === field.key)?.default;
    if (form.value[field.key] === undefined || form.value[field.key] === prevDef) form.value[field.key] = field.default ?? '';
  }
  if (providerType === 'rerank_api') {
    modelMapEntries.value = [{ task: 'rerank', model: '' }];
    form.value.temperature = undefined;
    form.value.max_completion_tokens = undefined;
    form.value.max_context_tokens = undefined;
  } else if (previousType === 'rerank_api' && modelMapEntries.value.length === 1 && modelMapEntries.value[0].task === 'rerank' && !modelMapEntries.value[0].model) {
    modelMapEntries.value = [{ task: 'chat', model: '' }];
  }
}
function closeDialog() { dialog.value.visible = false; formErrors.value = {}; }
function addModelMapEntry() { modelMapEntries.value.push({ task: '', model: '' }); }
function removeModelMapEntry(idx) { modelMapEntries.value.splice(idx, 1); }
function buildModelMap() {
  const grouped = {};
  for (const entry of modelMapEntries.value) {
    const task = String(entry.task || '').trim();
    const model = String(entry.model || '').trim();
    if (!task || !model) continue;
    if (!grouped[task]) grouped[task] = [];
    if (!grouped[task].includes(model)) grouped[task].push(model);
  }
  return Object.fromEntries(Object.entries(grouped).map(([task, models]) => [task, models.length === 1 ? models[0] : models]));
}
function getProviderConfigFields(providerType) { return providerTypeMeta.value[providerType]?.config_fields || []; }
function normalizeProviderPayload(payload) {
  for (const field of getProviderConfigFields(payload.provider_type)) {
    if (payload[field.key] === '' || payload[field.key] === null || payload[field.key] === undefined) delete payload[field.key];
  }
  return payload;
}

function validateProviderForm() {
  const errors = {};
  const mm = buildModelMap();
  if (dialog.value.mode === 'create') {
    if (!form.value.name?.trim()) errors.name = '请填写 Provider 名称';
    if (!form.value.provider_type) errors.provider_type = '请选择 Provider 类型';
    if (!form.value.api_key?.trim()) errors.api_key = '请填写 API Key 或环境变量引用';
  }
  const endpoint = String(form.value.api_endpoint || '').trim();
  if (form.value.provider_type === 'rerank_api' && !endpoint) errors.api_endpoint = 'Rerank API 必须填写 Endpoint';
  if (endpoint && !endpoint.includes('${')) {
    try { new URL(endpoint); } catch { errors.api_endpoint = '请输入完整的 http:// 或 https:// 地址'; }
  }
  const hasIncompleteRow = modelMapEntries.value.some((entry) => Boolean(String(entry.task || '').trim()) !== Boolean(String(entry.model || '').trim()));
  if (hasIncompleteRow) errors.model_map = '每条模型映射都需要同时选择任务并填写模型名';
  else if (Object.keys(mm).length === 0) errors.model_map = '至少配置一个任务模型';
  else if (form.value.provider_type === 'rerank_api' && !mm.rerank) errors.model_map = 'Rerank API 必须配置 Rerank 模型';
  return errors;
}

const { run: runSubmit, loading: saving } = useAsyncAction(
  async () => {
    const mm = buildModelMap();
    if (dialog.value.mode === 'create') {
      if (!form.value.name?.trim()) throw new Error('请填写名称');
      if (!form.value.provider_type) throw new Error('请选择 Provider 类型');
      if (!form.value.api_key?.trim()) throw new Error('请填写 API Key');
    }
    if (Object.keys(mm).length === 0) throw new Error('请至少配置一个任务模型');
    if (form.value.provider_type === 'rerank_api') {
      if (!form.value.api_endpoint?.trim()) throw new Error('请填写 API Endpoint');
      if (!mm.rerank) throw new Error('请配置 model_map.rerank');
    }
    const isCreate = dialog.value.mode === 'create';
    const payload = normalizeProviderPayload({ ...form.value, model_map: mm });
    if (isCreate) await createProvider(payload);
    else {
      if (!payload.api_key?.trim()) delete payload.api_key;
      await updateProvider(editingKey.value, payload);
    }
    closeDialog();
    await loadProviders();
    return isCreate ? 'create' : 'update';
  },
  {
    successMessage: (r) => (r === 'create' ? 'Provider 创建成功' : 'Provider 更新成功'),
    errorPrefix: '操作失败',
    showErrorToast: false,
    onError: (e) => { dialog.value.error = e?.message || '操作失败'; },
  },
);
function handleSubmit() {
  dialog.value.error = '';
  formErrors.value = validateProviderForm();
  if (Object.values(formErrors.value).some(Boolean)) return;
  runSubmit();
}

function usageKindLabel(kind) {
  return { agent: 'Agent', vectorizer: '向量化器', reranker: 'Reranker' }[kind] || kind;
}
async function confirmDelete(provider) {
  deleteTarget.value = provider;
  deleteUsages.value = [];
  deleteUsageError.value = '';
  deleteUsageLoading.value = true;
  try {
    deleteUsages.value = await getProviderUsages(getProviderKey(provider));
  } catch (e) {
    deleteUsageError.value = e?.message || '无法检查 Provider 引用关系';
  } finally {
    deleteUsageLoading.value = false;
  }
}
const { run: runDelete, loading: deleting } = useAsyncAction(
  async () => {
    if (!deleteTarget.value) return;
    const key = getProviderKey(deleteTarget.value);
    await deleteProvider(key);
    deleteTarget.value = null;
    deleteUsages.value = [];
    await loadProviders();
  },
  { successMessage: 'Provider 删除成功', errorPrefix: '删除失败' },
);
function doDelete() { runDelete(); }

onMounted(() => { Promise.all([loadProviderTypes(), loadProviders()]); });
onBeforeUnmount(() => cleanupProviderDrag());
</script>

<style scoped>
.provider-summary-bar { display: flex; align-items: center; gap: 8px; min-height: 34px; flex-wrap: wrap; }
.provider-summary-label { color: var(--color-text-secondary); font-size: 12px; font-weight: 700; }
.inline-actions { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.provider-list-section { min-height: 200px; }
.reorder-status { font-size: 12px; color: var(--color-text-secondary); }
.reorder-status--error { color: var(--color-error); }
.provider-toolbar { display: grid; grid-template-columns: minmax(240px, 1fr) minmax(180px, 220px) auto; gap: 10px; align-items: center; margin-bottom: 14px; }
.provider-filter-count { color: var(--color-text-muted); font-size: 12px; white-space: nowrap; }
.provider-filter-empty { padding: 32px 16px; text-align: center; color: var(--color-text-secondary); font-size: 13px; }

.provider-list { position: relative; display: flex; flex-direction: column; gap: 8px; }
.provider-row { position: relative; display: flex; flex-direction: column; padding: 10px 12px 10px 0; overflow: hidden; border-radius: 12px; }
.provider-row--dragging { opacity: 0; border-color: transparent; background: transparent; box-shadow: none; }
.provider-row--dragging > * { visibility: hidden; }
.provider-row-drag-image { opacity: 1; }
.provider-row-drag-image > * { visibility: visible; }
.provider-row-list-move { transition: transform 0.22s cubic-bezier(.2,.8,.2,1); will-change: transform; }
.provider-row-list-enter-active { transition: opacity 0.16s ease, transform 0.22s cubic-bezier(.2,.8,.2,1); }
.provider-row-list-leave-active { position: absolute; width: 100%; pointer-events: none; transition: opacity 0.14s ease, transform 0.14s ease; }
.provider-row-list-enter-from, .provider-row-list-leave-to { opacity: 0; transform: translateY(8px); }

.provider-row-main { display: grid; grid-template-columns: 48px minmax(260px, 1fr) auto; gap: 12px; align-items: center; min-width: 0; }
.drag-handle { align-self: stretch; display: inline-flex; align-items: center; justify-content: center; gap: 5px; width: 48px; border: none; border-radius: 0; background: transparent; color: var(--color-text-muted); cursor: grab; }
.drag-handle:focus-visible { outline: 2px solid var(--color-brand-accent); outline-offset: -2px; }
.drag-handle:active:not(:disabled) { cursor: grabbing; }
.drag-handle:disabled { opacity: 0.55; cursor: not-allowed; }
.order-index { min-width: 18px; font-size: 11px; font-weight: 800; letter-spacing: 0.04em; color: inherit; text-align: right; }

.provider-identity { display: flex; flex-direction: column; justify-content: center; gap: 8px; min-width: 0; }
.provider-title-line, .provider-status-line, .provider-models { display: flex; align-items: center; gap: 7px; min-width: 0; flex-wrap: wrap; }
.provider-name { min-width: 0; color: var(--color-text-primary); font-size: 14px; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider-title-divider { width: 1px; height: 14px; flex-shrink: 0; background: var(--color-border); }
.provider-type-text { flex-shrink: 0; color: var(--color-text-secondary); font-size: 12px; font-weight: 600; letter-spacing: 0.02em; }
.provider-endpoint { min-width: 120px; max-width: min(420px, 55vw); color: var(--color-text-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider-models-empty { color: var(--color-text-muted); font-size: 12px; }
.provider-row-actions { display: inline-flex; align-items: center; justify-content: flex-end; gap: 5px; flex-wrap: nowrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }

.provider-test-result { display: flex; align-items: flex-start; gap: 8px; margin: 8px 0 0 60px; padding: 8px 10px; border-radius: 8px; border: 1px solid transparent; font-size: 12px; line-height: 1.5; word-break: break-word; }
.result--ok { background: var(--color-success-bg); border-color: rgba(var(--color-success-rgb), 0.18); color: var(--color-success); }
.result--err { background: var(--color-error-bg); border-color: rgba(var(--color-error-rgb), 0.18); color: var(--color-error); }
.result-icon { flex-shrink: 0; }
.result-msg { display: flex; min-width: 0; flex-direction: column; gap: 1px; }

.dialog-form { display: flex; flex-direction: column; gap: 18px; }
.dialog-form-section { display: flex; flex-direction: column; gap: 14px; padding: 0 0 18px; border-bottom: 1px solid var(--color-border); }
.dialog-form-section:last-of-type { padding-bottom: 0; border-bottom: 0; }
.dialog-form-section__head { display: flex; flex-direction: column; gap: 4px; }
.dialog-form-section__head h3 { margin: 0; font-size: 15px; color: var(--color-text-primary); }
.dialog-form-section__head p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--color-text-secondary); }
.dialog-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.dialog-form-grid__full { grid-column: 1 / -1; }
.provider-dialog-footer { position: sticky; bottom: -24px; margin: 0 -24px -24px; padding: 14px 24px 24px; border-top: 1px solid var(--color-border); background: var(--color-bg-elevated); }
.required { color: var(--color-error); }
.capability-fields { gap: 10px; }
.form-section-title { font-size: 0.83rem; font-weight: 700; color: var(--color-text-primary); border-bottom: 1px solid var(--color-border); padding-bottom: 6px; }
.model-map-editor { display: flex; flex-direction: column; gap: 10px; }
.model-map-row { display: grid; grid-template-columns: minmax(130px, 0.6fr) auto minmax(180px, 1fr) auto; align-items: center; gap: 8px; }
.map-arrow { color: var(--color-text-muted); flex-shrink: 0; }
.delete-confirm-msg { margin: 0; color: var(--color-text-secondary); line-height: 1.7; }
.delete-usage-loading { margin: 0; color: var(--color-text-secondary); font-size: 13px; }
.delete-usage-list { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-warning-bg); font-size: 13px; }
.delete-usage-item { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 8px; align-items: center; }
.delete-usage-item small { grid-column: 2; color: var(--color-text-secondary); }
.spin { animation: g-spin 0.8s linear infinite; }

@media (max-width: 900px) {
  .provider-toolbar { grid-template-columns: minmax(0, 1fr) minmax(160px, 220px); }
  .provider-filter-count { grid-column: 1 / -1; }
  .provider-row-main { grid-template-columns: 48px minmax(0, 1fr); }
  .provider-row-actions { grid-column: 2; justify-content: flex-start; flex-wrap: wrap; }
  .provider-test-result { margin-left: 60px; }
  .dialog-form-grid { grid-template-columns: 1fr; }
  .dialog-form-grid__full { grid-column: 1; }
}
@media (max-width: 640px) {
  .provider-summary-bar { align-items: flex-start; }
  .provider-toolbar { grid-template-columns: 1fr; }
  .provider-filter-count { grid-column: 1; }
  .provider-row { padding: 0 12px 12px; }
  .provider-row-main { grid-template-columns: 1fr; }
  .drag-handle, .provider-identity, .provider-row-actions { grid-column: 1; }
  .drag-handle { width: calc(100% + 24px); min-height: 36px; margin-left: -12px; justify-content: flex-start; padding: 0 12px; border-bottom: 1px solid var(--color-border); }
  .provider-row-actions { flex-wrap: wrap; }
  .provider-test-result { margin: 8px 0 0; }
  .provider-endpoint { max-width: 100%; }
  .model-map-row { grid-template-columns: minmax(100px, 0.7fr) auto minmax(120px, 1fr) auto; gap: 6px; }
}
</style>
