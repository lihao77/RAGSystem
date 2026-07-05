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
      <UiIconButton variant="primary" label="添加 Provider" @click="openCreateDialog">
        <IconPlus :size="15" />
      </UiIconButton>
    </template>

    <template #header-menu="{ close }">
      <button class="pl-menu-item" @click="openCreateDialog(); close()">
        <IconPlus :size="16" />
        添加 Provider
      </button>
      <button class="pl-menu-item" :disabled="loading" @click="loadProviders(); close()">
        <IconRefresh :size="16" :class="{ spin: loading }" />
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </template>

    <template #mobile-menu="{ close }">
      <button class="pl-menu-item" @click="openCreateDialog(); close()">
        <IconPlus :size="16" />
        添加 Provider
      </button>
      <button class="pl-menu-item" :disabled="loading" @click="loadProviders(); close()">
        <IconRefresh :size="16" :class="{ spin: loading }" />
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </template>

    <KpiCards :items="kpiItems" />

    <EntityListLayout
      class="provider-list-section"
      title="Provider 列表"
      description="查看 Provider 配置、模型映射与连通性测试结果，统一管理模型接入实例。"
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
          <UiButton :disabled="loading || reordering" @click="loadProviders">
            <template #icon>
              <IconRefresh :size="14" :class="{ spin: loading }" />
            </template>
            {{ loading ? '刷新中...' : '刷新列表' }}
          </UiButton>
        </div>
      </template>
      <template #empty-icon>
        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
      </template>

      <TransitionGroup name="provider-row-list" tag="div" class="provider-list adm-entity-list">
        <article
          v-for="(provider, index) in providers"
          :key="getProviderKey(provider)"
          class="provider-row adm-entity-row"
          :class="{ 'provider-row--dragging': draggingKey === getProviderKey(provider) }"
          :data-provider-key="getProviderKey(provider)"
        >
          <div class="provider-row-main">
            <button type="button" class="drag-handle" title="拖拽调整顺序" :disabled="reordering" @pointerdown="startProviderDrag($event, provider)">
              <span class="order-index">{{ index + 1 }}</span>
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/></svg>
            </button>

            <div class="provider-identity" :title="getProviderKey(provider)">
              <div class="provider-title-line">
                <strong class="provider-name">{{ provider.name || provider.key }}</strong>
                <span class="provider-title-divider" aria-hidden="true"></span>
                <span class="provider-type-text">{{ provider.provider_type || 'custom' }}</span>
              </div>
              <div class="provider-endpoint mono">{{ provider.api_endpoint || '未配置 Endpoint' }}</div>
            </div>

            <div class="provider-row-actions">
              <button class="adm-action-btn adm-action-btn--success" :disabled="testingKey === getProviderKey(provider)" @click="quickTest(provider)">
                <div v-if="testingKey === getProviderKey(provider)" class="g-spinner g-spinner--sm"></div>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                {{ testingKey === getProviderKey(provider) ? '测试中' : '测试' }}
              </button>
              <button class="adm-action-btn" @click="openEditDialog(provider)">
                <IconEdit :size="14" />
                编辑
              </button>
              <button class="adm-action-btn adm-action-btn--danger" @click="confirmDelete(provider)">
                <IconTrash :size="14" />
                删除
              </button>
            </div>
          </div>

          <div v-if="testResults[getProviderKey(provider)]" class="provider-test-result" :class="testResults[getProviderKey(provider)].ok ? 'result--ok' : 'result--err'">
            <span class="result-icon">{{ testResults[getProviderKey(provider)].ok ? '✓' : '✗' }}</span>
            <span class="result-msg">{{ testResults[getProviderKey(provider)].msg }}</span>
          </div>
        </article>
      </TransitionGroup>
    </EntityListLayout>

    <AdmModal :open="dialog.visible" :title="dialog.mode === 'create' ? '添加 Provider' : '编辑 Provider'" width="720px" @close="closeDialog">
      <div class="dialog-form form-section">
        <section class="dialog-form-section form-section">
          <div class="dialog-form-section__head"><h3>基础配置</h3><p>填写 Provider 标识、鉴权信息与基础接入地址。</p></div>
          <div class="dialog-form-grid form-grid">
            <div class="form-row form-item" v-if="dialog.mode === 'create'">
              <label class="form-label field-label-text">名称 <span class="required">*</span></label>
              <input v-model="form.name" class="form-control" placeholder="例如: my_gpt" />
              <p class="form-hint">Provider 实例的唯一名称，不可包含空格</p>
            </div>
            <div class="form-row form-item" v-if="dialog.mode === 'create'">
              <label class="form-label field-label-text">Provider 类型 <span class="required">*</span></label>
              <CustomSelect :model-value="form.provider_type" :options="providerTypeOptions" placeholder="-- 请选择 --" @update:model-value="handleProviderTypeChange" />
            </div>
            <div class="form-row form-item dialog-form-grid__full form-grid__full">
              <label class="form-label field-label-text">API Key <span v-if="dialog.mode === 'create'" class="required">*</span></label>
              <input v-model="form.api_key" class="form-control" type="password" :placeholder="dialog.mode === 'create' ? 'sk-... 或 ${ENV_VAR}' : '留空则保持当前 API Key'" autocomplete="new-password" />
              <p class="form-hint">{{ dialog.mode === 'create' ? '支持 ${ENV_VAR} 形式引用环境变量' : '仅在需要替换密钥时填写；留空表示保持当前值' }}</p>
            </div>
            <div class="form-row form-item dialog-form-grid__full form-grid__full">
              <label class="form-label field-label-text">API Endpoint</label>
              <input v-model="form.api_endpoint" class="form-control" :placeholder="apiEndpointPlaceholder" />
            </div>
          </div>
        </section>

        <section v-if="form.provider_type !== 'rerank_api'" class="dialog-form-section form-section">
          <div class="dialog-form-section__head"><h3>运行参数</h3><p>配置温度、token 上限与超时时间等运行时参数。</p></div>
          <div class="dialog-form-grid form-grid">
            <div class="form-row form-item"><label class="form-label field-label-text">温度</label><input v-model.number="form.temperature" class="form-control" type="number" step="0.1" min="0" max="2" placeholder="0.7" /></div>
            <div class="form-row form-item"><label class="form-label field-label-text">Max Completion Tokens</label><input v-model.number="form.max_completion_tokens" class="form-control" type="number" step="256" min="256" placeholder="4096" /></div>
            <div class="form-row form-item"><label class="form-label field-label-text">Max Context Tokens</label><input v-model.number="form.max_context_tokens" class="form-control" type="number" step="1024" min="1024" placeholder="128000" /></div>
            <div class="form-row form-item"><label class="form-label field-label-text">Timeout (s)</label><input v-model.number="form.timeout" class="form-control" type="number" step="5" min="5" placeholder="60" /></div>
            <div class="form-row form-item dialog-form-grid__full form-grid__full">
              <label class="form-label field-label-text">工具调用协议</label>
              <label class="fc-toggle"><ToggleSwitch v-model="form.supports_function_calling" /><span>启用原生 Function Calling</span></label>
              <label class="fc-toggle"><ToggleSwitch v-model="form.supports_vision" /><span>支持图片输入（Vision）</span></label>
              <p class="form-hint">勾选后 OpenAI 兼容 Provider 走厂商原生 FC（需模型支持）；anthropic 自动走原生 tool_use 无需此项；不勾选则回退 XML 协议。Vision 项标记模型能否识别图片。</p>
            </div>
          </div>
        </section>

        <section class="dialog-form-section form-section">
          <div class="dialog-form-section__head"><h3>模型与扩展</h3><p>管理 Provider 的扩展字段与任务模型映射。</p></div>
          <template v-if="activeProviderConfigFields.length > 0">
            <div class="form-section-title">Provider 扩展配置</div>
            <div class="dialog-form-grid form-grid">
              <div v-for="field in activeProviderConfigFields" :key="field.key" class="form-row form-item">
                <label class="form-label field-label-text">{{ field.label }}</label>
                <CustomSelect v-if="field.type === 'select'" :model-value="form[field.key] ?? ''" :options="field.options || []" :placeholder="field.placeholder || '-- 请选择 --'" @update:model-value="form[field.key] = $event" />
                <input v-else-if="field.type === 'number'" v-model.number="form[field.key]" class="form-control" type="number" :step="field.step || 1" :min="field.min" :max="field.max" :placeholder="field.placeholder || ''" />
                <input v-else v-model="form[field.key]" class="form-control" :type="field.type === 'password' ? 'password' : 'text'" :placeholder="field.placeholder || ''" />
                <p v-if="field.help" class="form-hint">{{ field.help }}</p>
              </div>
            </div>
          </template>
          <div class="form-section-title">模型映射 (model_map)</div>
          <p class="form-hint form-hint--section">按任务类型指定模型名，如 chat / embedding / rerank</p>
          <div class="model-map-editor">
            <div v-for="(entry, idx) in modelMapEntries" :key="idx" class="model-map-row">
              <input v-model="entry.task" class="form-control form-control--sm" placeholder="chat" />
              <span class="map-arrow">→</span>
              <input v-model="entry.model" class="form-control" placeholder="gpt-4o" />
              <button type="button" class="icon-btn icon-btn--delete" @click="removeModelMapEntry(idx)">
                <IconClose :size="14" />
              </button>
            </div>
            <button type="button" class="btn-add-row" @click="addModelMapEntry">+ 添加映射</button>
          </div>
        </section>

        <div v-if="dialog.error" class="form-error">{{ dialog.error }}</div>
      </div>
      <template #footer>
        <UiButton size="compact" @click="closeDialog">取消</UiButton>
        <UiButton size="compact" variant="primary" :disabled="saving" @click="handleSubmit">{{ saving ? '保存中...' : '保存' }}</UiButton>
      </template>
    </AdmModal>

    <AdmModal :open="!!deleteTarget" title="确认删除" width="420px" @close="deleteTarget = null">
      <p class="delete-confirm-msg">确定要删除 Provider <strong>{{ deleteTarget ? getProviderKey(deleteTarget) : '' }}</strong> 吗？此操作不可撤销。</p>
      <template #footer>
        <UiButton size="compact" @click="deleteTarget = null">取消</UiButton>
        <UiButton size="compact" variant="danger" :disabled="deleting" @click="doDelete">{{ deleting ? '删除中...' : '确认删除' }}</UiButton>
      </template>
    </AdmModal>
  </PageLayout>
</template>

<script setup>
import { ref, computed, onMounted, h } from 'vue';
import CustomSelect from '../components/ui/CustomSelect.vue';
import ToggleSwitch from '../components/ToggleSwitch.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import KpiCards from '../components/admin/KpiCards.vue';
import AdmModal from '../components/admin/AdmModal.vue';
import PageLayout from '../components/PageLayout.vue';
import IconRefresh from '../components/icons/IconRefresh.vue';
import IconClose from '../components/icons/IconClose.vue';
import IconPlus from '../components/icons/IconPlus.vue';
import IconTrash from '../components/icons/IconTrash.vue';
import IconEdit from '../components/icons/IconEdit.vue';
import { UiButton, UiIconButton } from '../components/ui';
import { useToast } from '../composables/useToast.js';
import { useEntityList } from '../composables/useEntityList.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import {
  getProviderTypes, getProviders, createProvider, updateProvider,
  deleteProvider, reorderProviders, testProvider,
} from '../api/modelAdapter.js';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const toast = useToast();

const SVG = { xmlns: 'http://www.w3.org/2000/svg', width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
const IconTotal = () => h('svg', SVG, [h('circle', { cx: 12, cy: 12, r: 10 }), h('path', { d: 'M12 8v4l3 3' })]);
const IconModels = () => h('svg', SVG, [h('polygon', { points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2' })]);
const IconTypes = () => h('svg', SVG, [h('path', { d: 'M4 6h16M4 12h16M4 18h7' })]);
const IconEmbedding = () => h('svg', SVG, [h('line', { x1: 6, y1: 3, x2: 6, y2: 15 }), h('circle', { cx: 18, cy: 6, r: 3 }), h('circle', { cx: 6, cy: 18, r: 3 }), h('path', { d: 'M18 9a9 9 0 0 1-9 9' })]);

const providerTypeMeta = ref({});
const providerTypeOptions = ref([]);

const FALLBACK_PROVIDER_TYPES = [
  { value: 'openai', label: 'OpenAI', default_endpoint: 'https://api.openai.com/v1', config_fields: [{ key: 'reasoning_effort', label: '推理强度', type: 'select', default: '', help: '仅对支持 reasoning_effort 的 OpenAI 推理模型生效；留空则使用模型默认值。', options: [{ value: '', label: '模型默认' }, { value: 'none', label: 'None' }, { value: 'minimal', label: 'Minimal' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'xhigh', label: 'XHigh' }] }] },
  { value: 'deepseek', label: 'DeepSeek', default_endpoint: 'https://api.deepseek.com/v1', config_fields: [] },
  { value: 'openrouter', label: 'OpenRouter', default_endpoint: 'https://openrouter.ai/api/v1', config_fields: [] },
  { value: 'modelscope', label: 'ModelScope', default_endpoint: 'https://api-inference.modelscope.cn/v1', config_fields: [] },
  { value: 'rerank_api', label: 'Rerank API', default_endpoint: '', config_fields: [] },
];

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

const { items: providers, loading, error, refresh: loadProviders } = useEntityList(getProviders, { errorPrefix: '加载失败' });

const testingKey = ref('');
const testResults = ref({});
const deleteTarget = ref(null);
const draggingKey = ref('');
const dragOriginalProviders = ref(null);
const dragOrderChanged = ref(false);
let dragImageEl = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragPointerId = null;
const reordering = ref(false);
const reorderError = ref('');

const totalModels = computed(() => providers.value.reduce((acc, p) => acc + (p.models?.length || 0), 0));
const uniqueTypes = computed(() => new Set(providers.value.map((p) => p.provider_type).filter(Boolean)).size);
const embeddingCount = computed(() => providers.value.filter((p) => hasModelMapValue(p.model_map?.embedding)).length);

const kpiItems = computed(() => [
  { key: 'total', label: 'Provider 总数', value: providers.value.length, icon: IconTotal },
  { key: 'models', label: '可用模型数', value: totalModels.value, icon: IconModels },
  { key: 'types', label: 'Provider 类型', value: uniqueTypes.value, icon: IconTypes },
  { key: 'embedding', label: '支持 Embedding', value: embeddingCount.value, icon: IconEmbedding },
]);

function getProviderKey(provider) { return provider.key || `${provider.name}_${provider.provider_type}`; }
function normalizeModelList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  const model = String(value || '').trim();
  return model ? [model] : [];
}
function hasModelMapValue(value) { return normalizeModelList(value).length > 0; }
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

function startProviderDrag(event, provider) {
  if (reordering.value || event.button !== 0) return;
  const row = event.currentTarget.closest('.provider-row');
  if (!row) return;
  event.preventDefault();
  row.setPointerCapture?.(event.pointerId);
  dragPointerId = event.pointerId;
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
  dragPointerId = null;
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
  testingKey.value = key;
  testResults.value = { ...testResults.value, [key]: null };
  try {
    const target = getPreferredTestTarget(provider);
    const result = await testProvider(provider.name, target.model, target.prompt, provider.provider_type || '', target.task);
    if (result.error) throw new Error(result.error);
    let message = `响应: ${(result.response?.content || result.content || '').slice(0, 60)}`;
    if (target.task === 'embedding') message = `Embedding 维度: ${result.embeddings?.[0]?.length || result.response?.embeddings?.[0]?.length || 0}`;
    else if (target.task === 'rerank') message = `Rerank 返回: ${result.results?.length || result.response?.results?.length || 0} 条`;
    testResults.value = { ...testResults.value, [key]: { ok: true, msg: message } };
    toast.success('Provider 连通性测试成功');
  } catch (e) {
    const message = e?.message || '测试失败';
    testResults.value = { ...testResults.value, [key]: { ok: false, msg: message } };
    toast.error(message);
  } finally {
    testingKey.value = '';
  }
}

const dialog = ref({ visible: false, mode: 'create', error: '' });
const editingKey = ref('');
const form = ref({});
const modelMapEntries = ref([]);

const apiEndpointPlaceholder = computed(() => {
  const providerType = form.value.provider_type;
  if (providerType === 'rerank_api') return '例如: https://api.jina.ai/v1/rerank';
  return providerTypeMeta.value[providerType]?.default_endpoint || '由后端返回默认 API Endpoint';
});
const activeProviderConfigFields = computed(() => providerTypeMeta.value[form.value.provider_type]?.config_fields || []);

function buildFormDefaults() {
  return { name: '', provider_type: '', api_key: '', api_endpoint: '', temperature: 0.7, max_completion_tokens: 4096, max_context_tokens: 128000, timeout: 60, supports_function_calling: false, supports_vision: false };
}
function openCreateDialog() {
  form.value = buildFormDefaults();
  modelMapEntries.value = [{ task: 'chat', model: '' }];
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
function closeDialog() { dialog.value.visible = false; }
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

const { run: runSubmit, loading: saving } = useAsyncAction(
  async () => {
    const mm = buildModelMap();
    if (dialog.value.mode === 'create') {
      if (!form.value.name?.trim()) throw new Error('请填写名称');
      if (!form.value.provider_type) throw new Error('请选择 Provider 类型');
      if (!form.value.api_key?.trim()) throw new Error('请填写 API Key');
    }
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
function handleSubmit() { dialog.value.error = ''; runSubmit(); }

function confirmDelete(provider) { deleteTarget.value = provider; }
const { run: runDelete, loading: deleting } = useAsyncAction(
  async () => {
    if (!deleteTarget.value) return;
    const key = getProviderKey(deleteTarget.value);
    await deleteProvider(key);
    deleteTarget.value = null;
    await loadProviders();
  },
  { successMessage: 'Provider 删除成功', errorPrefix: '删除失败' },
);
function doDelete() { runDelete(); }

onMounted(() => { loadProviderTypes(); loadProviders(); });
</script>

<style scoped>
.inline-actions { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.provider-list-section { min-height: 200px; }
.reorder-status { font-size: 12px; color: var(--color-text-secondary); }
.reorder-status--error { color: var(--color-error); }

.provider-list { display: flex; flex-direction: column; gap: 8px; }
.provider-row { position: relative; display: flex; flex-direction: column; padding: 0 12px 0 0; overflow: hidden; border-radius: 16px; }
.provider-row--dragging { opacity: 0; border-color: transparent; background: transparent; box-shadow: none; }
.provider-row--dragging > * { visibility: hidden; }
.provider-row-drag-image { opacity: 1; }
.provider-row-drag-image > * { visibility: visible; }
.provider-row-list-move, .provider-row-list-enter-active, .provider-row-list-leave-active { transition: transform 0.28s cubic-bezier(.2,.8,.2,1); will-change: transform; }
.provider-row-list-enter-from, .provider-row-list-leave-to { opacity: 0; transform: translateY(8px); }

.provider-row-main { display: grid; grid-template-columns: 48px minmax(240px, 1fr) auto; gap: 10px; align-items: stretch; min-width: 0; min-height: 46px; }
.drag-handle { height: 100%; min-height: 46px; display: inline-flex; flex-direction: row; align-items: center; justify-content: center; gap: 6px; width: 48px; border: none; border-radius: 0; background: var(--adm-control-bg); color: var(--color-text-muted); cursor: grab; transition: background 0.16s ease, color 0.16s ease; }
.drag-handle:hover:not(:disabled) { color: var(--color-text-secondary); background: var(--adm-control-hover); }
.drag-handle:active:not(:disabled) { cursor: grabbing; }
.drag-handle:disabled { opacity: 0.55; cursor: not-allowed; }
.order-index { min-width: 18px; font-size: 11px; font-weight: 800; letter-spacing: 0.04em; color: inherit; text-align: right; }

.provider-identity { display: flex; flex-direction: column; justify-content: center; gap: 6px; min-width: 0; }
.provider-title-line { display: flex; align-items: center; gap: 10px; min-width: 0; }
.provider-name { min-width: 0; color: var(--color-text-primary); font-size: 14px; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider-title-divider { width: 1px; height: 14px; flex-shrink: 0; background: rgba(var(--color-border-rgb, 148,163,184), 0.62); }
.provider-type-text { flex-shrink: 0; color: var(--color-text-secondary); font-size: 12px; font-weight: 600; letter-spacing: 0.02em; }
.provider-endpoint { display: flex; align-items: center; min-width: 0; color: var(--color-text-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider-row-actions { display: inline-flex; align-items: center; justify-content: flex-end; gap: 7px; flex-wrap: nowrap; }
.mono { font-family: inherit; }

.provider-test-result { display: flex; align-items: flex-start; gap: 8px; margin-left: 48px; padding: 9px 11px; border-radius: 13px; border: 1px solid transparent; font-size: 12px; line-height: 1.5; word-break: break-word; }
.result--ok { margin: 0 0 12px 24px; background: rgba(var(--color-success-rgb), 0.08); border-color: rgba(var(--color-success-rgb), 0.18); color: var(--color-success); }
.result--err { background: rgba(var(--color-error-rgb), 0.08); border-color: rgba(var(--color-error-rgb), 0.18); color: var(--color-error); }
.result-icon { flex-shrink: 0; font-weight: 700; }
.result-msg { min-width: 0; }

.icon-btn { width: 30px; height: 30px; border-radius: var(--control-radius); border: 1px solid var(--color-border); background: transparent; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background .15s ease, border-color .15s ease, color .15s ease; color: var(--color-text-secondary); }
.icon-btn:hover { background: var(--color-interactive-hover); }
.icon-btn--delete:hover { color: var(--color-error); border-color: rgba(var(--color-error-rgb), 0.22); }
.btn-add-row { background: none; border: 1px dashed var(--color-border); color: var(--color-text-muted); border-radius: 12px; padding: 10px 12px; font-size: 0.82rem; cursor: pointer; transition: border-color .15s ease, color .15s ease, background .15s ease; width: 100%; margin-top: 4px; }
.btn-add-row:hover { border-color: var(--color-brand-accent); color: var(--color-brand-accent); background: rgba(var(--color-brand-accent-rgb), 0.05); }

.dialog-form { display: flex; flex-direction: column; gap: 18px; }
.dialog-form-section { display: flex; flex-direction: column; gap: 14px; padding: 18px; border-radius: 18px; border: 1px solid var(--color-border); background: var(--color-hover-overlay); }
.dialog-form-section__head { display: flex; flex-direction: column; gap: 4px; }
.dialog-form-section__head h3 { margin: 0; font-size: 15px; color: var(--color-text-primary); }
.dialog-form-section__head p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--color-text-secondary); }
.dialog-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; }
.dialog-form-grid__full { grid-column: 1 / -1; }

.form-row { display: flex; flex-direction: column; gap: 6px; }
.form-label { font-size: 0.83rem; font-weight: 600; color: var(--color-text-primary); }
.required { color: var(--color-error, #f87171); }
.form-hint--section { margin-bottom: 4px; }
.fc-toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: var(--font-size-sm); color: var(--color-text-primary); }
.form-section-title { font-size: 0.83rem; font-weight: 700; color: var(--color-text-primary); border-bottom: 1px solid var(--color-border); padding-bottom: 6px; }

.model-map-editor { display: flex; flex-direction: column; gap: 10px; }
.model-map-row { display: flex; align-items: center; gap: 8px; }
.map-arrow { color: var(--color-text-muted); font-size: 14px; flex-shrink: 0; }
.delete-confirm-msg { margin: 0; color: var(--color-text-secondary); line-height: 1.7; }

.spin { animation: g-spin 0.8s linear infinite; }

@media (max-width: 1024px) { .provider-row-main { grid-template-columns: 72px minmax(260px, 1fr) auto; } }
@media (max-width: 900px) {
  .provider-row-main { grid-template-columns: 72px minmax(0, 1fr); align-items: stretch; }
  .provider-row-actions, .provider-test-result { grid-column: 2; margin-left: 0; padding-left: 0; }
  .provider-row-actions { justify-content: flex-start; flex-wrap: wrap; }
  .dialog-form-grid { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .provider-row { padding: 0 12px 12px 0; }
  .provider-row-main { grid-template-columns: 1fr; }
  .drag-handle, .provider-identity, .provider-row-actions, .provider-test-result { grid-column: 1; }
  .drag-handle { width: calc(100% + 12px); min-height: 36px; flex-direction: row; justify-content: flex-start; padding: 0 12px; border-right: 0; border-bottom: 1px solid rgba(var(--color-border-rgb, 148,163,184), 0.38); }
  .provider-row-actions { flex-wrap: wrap; }
}
</style>
