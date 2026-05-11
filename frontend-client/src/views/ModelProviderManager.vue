<template>
  <PageLayout
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    content-padding="var(--spacing-lg)"
    mobile-content-padding="var(--spacing-sm)"
    title="模型 Provider 管理"
    subtitle="管理 LLM Provider 实例：配置 API Key、模型映射、参数，并测试连通性。"
    mobile-title="Provider 管理"
  >
    <template #header-actions>
      <button class="pl-btn pl-btn--icon pl-btn--primary" title="添加 Provider" @click="openCreateDialog">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
    </template>

    <template #header-menu="{ close }">
      <button class="pl-menu-item" @click="openCreateDialog(); close()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        添加 Provider
      </button>
      <button class="pl-menu-item" :disabled="loading" @click="loadProviders(); close()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="{ spin: loading }">
          <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </template>

    <template #mobile-menu="{ close }">
      <button class="pl-menu-item" @click="openCreateDialog(); close()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        添加 Provider
      </button>
      <button class="pl-menu-item" :disabled="loading" @click="loadProviders(); close()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="{ spin: loading }">
          <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
        {{ loading ? '刷新中...' : '刷新' }}
      </button>
    </template>

      <!-- ── 统计卡片 ──────────────────────────────────── -->
      <section class="summary-grid adm-kpi-grid">
        <article class="summary-card adm-kpi-card">
          <div class="summary-icon adm-kpi-icon summary-icon--total">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
            </svg>
          </div>
          <div class="summary-body adm-kpi-body">
            <span class="summary-label adm-kpi-label">Provider 总数</span>
            <strong class="summary-value adm-kpi-value">{{ providers.length }}</strong>
          </div>
        </article>
        <article class="summary-card adm-kpi-card">
          <div class="summary-icon adm-kpi-icon summary-icon--openai">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </div>
          <div class="summary-body adm-kpi-body">
            <span class="summary-label adm-kpi-label">可用模型数</span>
            <strong class="summary-value adm-kpi-value summary-value--connected">{{ totalModels }}</strong>
          </div>
        </article>
        <article class="summary-card adm-kpi-card">
          <div class="summary-icon adm-kpi-icon summary-icon--types">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 6h16M4 12h16M4 18h7"/>
            </svg>
          </div>
          <div class="summary-body adm-kpi-body">
            <span class="summary-label adm-kpi-label">Provider 类型</span>
            <strong class="summary-value adm-kpi-value summary-value--enabled">{{ uniqueTypes }}</strong>
          </div>
        </article>
        <article class="summary-card adm-kpi-card">
          <div class="summary-icon adm-kpi-icon summary-icon--embedding">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/>
              <circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
            </svg>
          </div>
          <div class="summary-body adm-kpi-body">
            <span class="summary-label adm-kpi-label">支持 Embedding</span>
            <strong class="summary-value adm-kpi-value summary-value--tools">{{ embeddingCount }}</strong>
          </div>
        </article>
      </section>

      <!-- ── Provider 列表 ──────────────────────────────── -->
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
            <button class="pl-btn" :disabled="loading || reordering" @click="loadProviders">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="{ spin: loading }">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
              {{ loading ? '刷新中...' : '刷新列表' }}
            </button>
          </div>
        </template>
        <template #empty-icon>
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
          </svg>
        </template>

        <TransitionGroup name="provider-row-list" tag="div" class="provider-list adm-entity-list">
          <article
            v-for="(provider, index) in providers"
            :key="getProviderKey(provider)"
            class="provider-row adm-entity-row"
            :class="{
              'provider-row--dragging': draggingKey === getProviderKey(provider)
            }"
            :data-provider-key="getProviderKey(provider)"
          >
            <div class="provider-row-main">
              <button
                type="button"
                class="drag-handle"
                title="拖拽调整顺序"
                :disabled="reordering"
                @pointerdown="startProviderDrag($event, provider)"
              >
                <span class="order-index">{{ index + 1 }}</span>
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/>
                  <circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>
                </svg>
              </button>

              <div class="provider-identity" :title="getProviderKey(provider)">
                <div class="provider-title-line">
                  <strong class="provider-name">{{ provider.name || provider.key }}</strong>
                  <span class="provider-title-divider" aria-hidden="true"></span>
                  <span class="provider-type-text">{{ provider.provider_type || 'custom' }}</span>
                </div>
                <div class="provider-endpoint mono">
                  {{ provider.api_endpoint || '未配置 Endpoint' }}
                </div>
              </div>

              <div class="provider-row-actions">
                <button class="adm-action-btn adm-action-btn--success act-btn act-btn--test"
                  :disabled="testingKey === getProviderKey(provider)"
                  @click="quickTest(provider)">
                  <div v-if="testingKey === getProviderKey(provider)" class="spinner spinner--sm"></div>
                  <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                  {{ testingKey === getProviderKey(provider) ? '测试中' : '测试' }}
                </button>
                <button class="adm-action-btn act-btn" @click="openEditDialog(provider)">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                  编辑
                </button>
                <button class="adm-action-btn adm-action-btn--danger act-btn act-btn--danger" @click="confirmDelete(provider)">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    <path d="M10 11v6"/><path d="M14 11v6"/>
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                  </svg>
                  删除
                </button>
              </div>
            </div>

            <div v-if="testResults[getProviderKey(provider)]" class="provider-test-result"
              :class="testResults[getProviderKey(provider)].ok ? 'result--ok' : 'result--err'">
              <span class="result-icon">{{ testResults[getProviderKey(provider)].ok ? '✓' : '✗' }}</span>
              <span class="result-msg">{{ testResults[getProviderKey(provider)].msg }}</span>
            </div>
          </article>
        </TransitionGroup>
      </EntityListLayout>

    <!-- ── 新增/编辑 Dialog ──────────────────────────────── -->
    <div v-if="dialog.visible" class="dialog-backdrop">
      <div ref="dialogPanelRef" class="dialog-panel adm-modal glass-card">
        <div class="dialog-header adm-modal-header">
          <h2>{{ dialog.mode === 'create' ? '添加 Provider' : '编辑 Provider' }}</h2>
          <button class="dialog-close" @click="closeDialog">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <form class="dialog-form adm-form" @submit.prevent="handleSubmit">
          <section class="dialog-form-section adm-form-section">
            <div class="dialog-form-section__head adm-form-section__head">
              <h3>基础配置</h3>
              <p>填写 Provider 标识、鉴权信息与基础接入地址。</p>
            </div>
            <div class="dialog-form-grid adm-form-grid">
              <!-- 基础字段（仅新建时可改） -->
              <div class="form-row adm-field" v-if="dialog.mode === 'create'">
                <label class="form-label adm-field-label">名称 <span class="required">*</span></label>
                <input v-model="form.name" class="form-control adm-form-control" placeholder="例如: my_gpt" />
                <p class="form-hint adm-form-hint">Provider 实例的唯一名称，不可包含空格</p>
              </div>
              <div class="form-row adm-field" v-if="dialog.mode === 'create'">
                <label class="form-label adm-field-label">Provider 类型 <span class="required">*</span></label>
                <CustomSelect
                  :model-value="form.provider_type"
                  :options="providerTypeOptions"
                  placeholder="-- 请选择 --"
                  @update:model-value="handleProviderTypeChange"
                />
              </div>
              <div class="form-row adm-field dialog-form-grid__full adm-form-grid__full">
                <label class="form-label adm-field-label">API Key <span v-if="dialog.mode === 'create'" class="required">*</span></label>
                <input v-model="form.api_key" class="form-control adm-form-control" type="password"
                  :placeholder="dialog.mode === 'create' ? 'sk-... 或 ${ENV_VAR}' : '留空则保持当前 API Key'" autocomplete="new-password" />
                <p class="form-hint adm-form-hint">
                  {{ dialog.mode === 'create' ? '支持 ${ENV_VAR} 形式引用环境变量' : '仅在需要替换密钥时填写；留空表示保持当前值' }}
                </p>
              </div>
              <div class="form-row adm-field dialog-form-grid__full adm-form-grid__full">
                <label class="form-label adm-field-label">API Endpoint</label>
                <input v-model="form.api_endpoint" class="form-control adm-form-control"
                  :placeholder="apiEndpointPlaceholder" />
              </div>
            </div>
          </section>

          <section class="dialog-form-section adm-form-section">
            <div class="dialog-form-section__head adm-form-section__head">
              <h3>运行参数</h3>
              <p>配置温度、token 上限与超时时间等运行时参数。</p>
            </div>
            <div class="dialog-form-grid adm-form-grid">
              <div class="form-row adm-field">
                <label class="form-label adm-field-label">温度</label>
                <input v-model.number="form.temperature" class="form-control adm-form-control" type="number"
                  step="0.1" min="0" max="2" placeholder="0.7" />
              </div>
              <div class="form-row adm-field">
                <label class="form-label adm-field-label">Max Completion Tokens</label>
                <input v-model.number="form.max_completion_tokens" class="form-control adm-form-control" type="number"
                  step="256" min="256" placeholder="4096" />
              </div>
              <div class="form-row adm-field">
                <label class="form-label adm-field-label">Max Context Tokens</label>
                <input v-model.number="form.max_context_tokens" class="form-control adm-form-control" type="number"
                  step="1024" min="1024" placeholder="128000" />
              </div>
              <div class="form-row adm-field">
                <label class="form-label adm-field-label">Timeout (s)</label>
                <input v-model.number="form.timeout" class="form-control adm-form-control" type="number"
                  step="5" min="5" placeholder="60" />
              </div>
            </div>
          </section>

          <section class="dialog-form-section adm-form-section">
            <div class="dialog-form-section__head adm-form-section__head">
              <h3>模型与扩展</h3>
              <p>管理 Provider 的扩展字段与任务模型映射。</p>
            </div>

            <template v-if="activeProviderConfigFields.length > 0">
              <div class="form-section-title adm-form-section-title">Provider 扩展配置</div>
              <div class="dialog-form-grid adm-form-grid">
                <div
                  v-for="field in activeProviderConfigFields"
                  :key="field.key"
                  class="form-row adm-field"
                >
                  <label class="form-label adm-field-label">{{ field.label }}</label>
                  <CustomSelect
                    v-if="field.type === 'select'"
                    :model-value="form[field.key] ?? ''"
                    :options="field.options || []"
                    :placeholder="field.placeholder || '-- 请选择 --'"
                    @update:model-value="form[field.key] = $event"
                  />
                  <input
                    v-else-if="field.type === 'number'"
                    v-model.number="form[field.key]"
                    class="form-control adm-form-control"
                    type="number"
                    :step="field.step || 1"
                    :min="field.min"
                    :max="field.max"
                    :placeholder="field.placeholder || ''"
                  />
                  <input
                    v-else
                    v-model="form[field.key]"
                    class="form-control adm-form-control"
                    :type="field.type === 'password' ? 'password' : 'text'"
                    :placeholder="field.placeholder || ''"
                  />
                  <p v-if="field.help" class="form-hint adm-form-hint">{{ field.help }}</p>
                </div>
              </div>
            </template>

            <div class="form-section-title adm-form-section-title">模型映射 (model_map)</div>
            <p class="form-hint adm-form-hint form-hint--section">按任务类型指定模型名，如 chat / embedding</p>
            <div class="model-map-editor">
              <div v-for="(entry, idx) in modelMapEntries" :key="idx" class="model-map-row">
                <input v-model="entry.task" class="form-control adm-form-control form-control--sm" placeholder="chat" />
                <span class="map-arrow">→</span>
                <input v-model="entry.model" class="form-control adm-form-control" placeholder="gpt-4o" />
                <button type="button" class="icon-btn icon-btn--delete" @click="removeModelMapEntry(idx)">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
              <button type="button" class="btn-add-row" @click="addModelMapEntry">+ 添加映射</button>
            </div>
          </section>

          <div v-if="dialog.error" class="form-error adm-form-error">{{ dialog.error }}</div>

          <div class="dialog-footer adm-modal-footer">
            <button type="button" class="adm-button btn-secondary" @click="closeDialog">取消</button>
            <button type="submit" class="adm-button adm-button--primary btn-primary" :disabled="dialog.saving">
              {{ dialog.saving ? '保存中...' : '保存' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- ── 删除确认 Dialog ───────────────────────────────── -->
    <div v-if="deleteTarget" class="dialog-backdrop">
      <div ref="deleteDialogPanelRef" class="dialog-panel adm-modal dialog-panel--sm glass-card">
        <div class="dialog-header adm-modal-header">
          <h2>确认删除</h2>
          <button class="dialog-close" @click="deleteTarget = null">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <p class="delete-confirm-msg">
          确定要删除 Provider <strong>{{ getProviderKey(deleteTarget) }}</strong> 吗？此操作不可撤销。
        </p>
        <div class="dialog-footer adm-modal-footer">
          <button class="adm-button btn-secondary" @click="deleteTarget = null">取消</button>
          <button class="adm-button adm-button--danger btn-danger" :disabled="deleting" @click="doDelete">
            {{ deleting ? '删除中...' : '确认删除' }}
          </button>
        </div>
      </div>
    </div>
    <AppToast ref="toastRef" />
  </PageLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import AppToast from '../components/AppToast.vue'
import CustomSelect from '../components/CustomSelect.vue'
import EntityListLayout from '../components/admin/EntityListLayout.vue'
import PageLayout from '../components/PageLayout.vue'
import { usePointerDownOutside } from '../composables/usePointerDownOutside'
import {
  getProviderTypes,
  getProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  reorderProviders,
  testProvider
} from '../api/modelAdapter.js'

const props = defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
})

const providerTypeMeta = ref({})
const providerTypeOptions = ref([])

const FALLBACK_PROVIDER_TYPES = [
  {
    value: 'openai',
    label: 'OpenAI',
    default_endpoint: 'https://api.openai.com/v1',
    config_fields: [
      {
        key: 'reasoning_effort',
        label: '推理强度',
        type: 'select',
        default: '',
        help: '仅对支持 reasoning_effort 的 OpenAI 推理模型生效；留空则使用模型默认值。',
        options: [
          { value: '', label: '模型默认' },
          { value: 'none', label: 'None' },
          { value: 'minimal', label: 'Minimal' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'xhigh', label: 'XHigh' },
        ],
      },
    ],
  },
  { value: 'deepseek', label: 'DeepSeek', default_endpoint: 'https://api.deepseek.com/v1', config_fields: [] },
  { value: 'openrouter', label: 'OpenRouter', default_endpoint: 'https://openrouter.ai/api/v1', config_fields: [] },
  { value: 'modelscope', label: 'ModelScope', default_endpoint: 'https://api-inference.modelscope.cn/v1', config_fields: [] },
]

async function loadProviderTypes() {
  try {
    const types = await getProviderTypes()
    providerTypeMeta.value = Object.fromEntries(
      types.map(t => [
        t.value,
        {
          label: t.label,
          default_endpoint: t.default_endpoint || '',
          config_fields: t.config_fields || [],
        }
      ])
    )
    providerTypeOptions.value = types.map(t => ({ value: t.value, label: t.label }))
  } catch {
    // 加载失败时用兜底静态列表
    providerTypeMeta.value = Object.fromEntries(
      FALLBACK_PROVIDER_TYPES.map(t => [
        t.value,
        {
          label: t.label,
          default_endpoint: t.default_endpoint,
          config_fields: t.config_fields || [],
        }
      ])
    )
    providerTypeOptions.value = FALLBACK_PROVIDER_TYPES.map(t => ({ value: t.value, label: t.label }))
  }
}

const providers = ref([])
const loading = ref(false)
const error = ref('')
const toastRef = ref(null)
const testingKey = ref('')
const testResults = ref({})
const deleteTarget = ref(null)
const deleteDialogPanelRef = ref(null)
const deleting = ref(false)
const draggingKey = ref('')
const dragOriginalProviders = ref(null)
const dragOrderChanged = ref(false)
let dragImageEl = null
let dragOffsetX = 0
let dragOffsetY = 0
let dragPointerId = null
const reordering = ref(false)
const reorderError = ref('')

usePointerDownOutside({
  inside: [deleteDialogPanelRef],
  enabled: () => Boolean(deleteTarget.value),
  onOutside: () => { deleteTarget.value = null },
})

function showToast(message, type = 'error') {
  toastRef.value?.show(message, type)
}

// ── 统计 ──
const totalModels = computed(() =>
  providers.value.reduce((acc, p) => acc + (p.models?.length || 0), 0)
)
const uniqueTypes = computed(() =>
  new Set(providers.value.map(p => p.provider_type).filter(Boolean)).size
)
const embeddingCount = computed(() =>
  providers.value.filter(p => hasModelMapValue(p.model_map?.embedding)).length
)

function getProviderKey(provider) {
  return provider.key || `${provider.name}_${provider.provider_type}`
}

function normalizeModelList(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean)
  }
  const model = String(value || '').trim()
  return model ? [model] : []
}

function hasModelMapValue(value) {
  return normalizeModelList(value).length > 0
}

function isSameProviderOrder(leftProviders, rightProviders) {
  if (leftProviders.length !== rightProviders.length) return false
  return leftProviders.every((provider, index) => getProviderKey(provider) === getProviderKey(rightProviders[index]))
}

function getDefaultModel(value) {
  return normalizeModelList(value)[0] || ''
}

async function persistProviderOrder(nextProviders, previousProviders, options = {}) {
  if (reordering.value) return
  providers.value = nextProviders
  reordering.value = true
  reorderError.value = ''
  try {
    await reorderProviders(nextProviders.map(getProviderKey))
    if (!options.silent) showToast('Provider 顺序已保存', 'success')
  } catch (e) {
    providers.value = previousProviders
    const message = e.message || '排序保存失败'
    reorderError.value = message
    showToast(message, 'error')
  } finally {
    reordering.value = false
    if (!options.skipCleanup) cleanupProviderDrag()
  }
}

function startProviderDrag(event, provider) {
  if (reordering.value || event.button !== 0) return
  const row = event.currentTarget.closest('.provider-row')
  if (!row) return
  event.preventDefault()
  row.setPointerCapture?.(event.pointerId)
  dragPointerId = event.pointerId

  const rect = row.getBoundingClientRect()
  draggingKey.value = getProviderKey(provider)
  dragOriginalProviders.value = [...providers.value]
  dragOrderChanged.value = false
  dragOffsetX = event.clientX - rect.left
  dragOffsetY = event.clientY - rect.top

  dragImageEl = row.cloneNode(true)
  dragImageEl.removeAttribute('data-provider-key')
  dragImageEl.classList.add('provider-row-drag-image')
  dragImageEl.style.width = `${rect.width}px`
  dragImageEl.style.position = 'fixed'
  dragImageEl.style.left = `${event.clientX - dragOffsetX}px`
  dragImageEl.style.top = `${event.clientY - dragOffsetY}px`
  dragImageEl.style.zIndex = '2000'
  dragImageEl.style.pointerEvents = 'none'
  dragImageEl.style.transition = 'none'
  document.body.appendChild(dragImageEl)

  window.addEventListener('pointermove', handleProviderDragMove)
  window.addEventListener('pointerup', finishProviderDrag, { once: true })
  window.addEventListener('pointercancel', cancelProviderDrag, { once: true })
}

function handleProviderDragMove(event) {
  if (!draggingKey.value || !dragImageEl) return
  dragImageEl.style.left = `${event.clientX - dragOffsetX}px`
  dragImageEl.style.top = `${event.clientY - dragOffsetY}px`

  const targetRow = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.provider-row')
  if (!targetRow) return
  const toKey = targetRow.dataset.providerKey
  const fromKey = draggingKey.value
  if (!toKey || toKey === fromKey || reordering.value) return

  const fromIndex = providers.value.findIndex(item => getProviderKey(item) === fromKey)
  const toIndex = providers.value.findIndex(item => getProviderKey(item) === toKey)
  if (fromIndex < 0 || toIndex < 0) return

  const rect = targetRow.getBoundingClientRect()
  const insertAfter = event.clientY > rect.top + rect.height / 2
  let targetIndex = insertAfter ? toIndex + 1 : toIndex
  if (fromIndex < targetIndex) targetIndex -= 1
  if (targetIndex === fromIndex) return

  const nextProviders = [...providers.value]
  const [moved] = nextProviders.splice(fromIndex, 1)
  nextProviders.splice(targetIndex, 0, moved)
  providers.value = nextProviders
  dragOrderChanged.value = true
}

async function finishProviderDrag() {
  if (!draggingKey.value || reordering.value) {
    cleanupProviderDrag()
    return
  }
  const previousProviders = dragOriginalProviders.value ? [...dragOriginalProviders.value] : [...providers.value]
  const nextProviders = [...providers.value]
  if (!dragOrderChanged.value || isSameProviderOrder(previousProviders, nextProviders)) {
    providers.value = previousProviders
    cleanupProviderDrag()
    return
  }
  await animateDragImageToPlaceholder()
  hideDragImage()
  cleanupProviderDrag({ keepImage: true })
  await persistProviderOrder(nextProviders, previousProviders, { skipCleanup: true, silent: true })
}

async function animateDragImageToPlaceholder() {
  if (!dragImageEl || !draggingKey.value) return
  const placeholder = Array.from(document.querySelectorAll('.provider-row'))
    .find(row => row !== dragImageEl && row.dataset.providerKey === draggingKey.value)
  if (!placeholder) return

  const startRect = dragImageEl.getBoundingClientRect()
  const targetRect = placeholder.getBoundingClientRect()
  const deltaX = targetRect.left - startRect.left
  const deltaY = targetRect.top - startRect.top
  if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return

  dragImageEl.style.left = `${startRect.left}px`
  dragImageEl.style.top = `${startRect.top}px`
  dragImageEl.style.width = `${targetRect.width}px`

  const animation = dragImageEl.animate(
    [
      { transform: 'translate3d(0, 0, 0)' },
      { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
    ],
    {
      duration: 220,
      easing: 'cubic-bezier(.2,.8,.2,1)',
      fill: 'forwards',
    }
  )

  try {
    await animation.finished
  } catch {
    // ignore cancelled animation
  }

  dragImageEl.style.left = `${targetRect.left}px`
  dragImageEl.style.top = `${targetRect.top}px`
  dragImageEl.style.transform = 'none'
}

function cancelProviderDrag() {
  if (dragOriginalProviders.value) {
    providers.value = dragOriginalProviders.value
  }
  cleanupProviderDrag()
}

function hideDragImage() {
  if (dragImageEl) {
    dragImageEl.style.visibility = 'hidden'
  }
}

function cleanupProviderDrag(options = {}) {
  const imageToRemove = dragImageEl
  draggingKey.value = ''
  dragOriginalProviders.value = null
  dragOrderChanged.value = false
  dragPointerId = null
  if (imageToRemove && !options.keepImage) {
    imageToRemove.remove()
  } else if (imageToRemove) {
    requestAnimationFrame(() => imageToRemove.remove())
  }
  dragImageEl = null
  window.removeEventListener('pointermove', handleProviderDragMove)
  window.removeEventListener('pointerup', finishProviderDrag)
  window.removeEventListener('pointercancel', cancelProviderDrag)
}

async function moveProvider(provider, direction) {
  if (reordering.value) return
  const previousProviders = [...providers.value]
  const nextProviders = [...providers.value]
  const index = nextProviders.findIndex(item => getProviderKey(item) === getProviderKey(provider))
  const targetIndex = index + direction
  if (index < 0 || targetIndex < 0 || targetIndex >= nextProviders.length) return
  draggingKey.value = getProviderKey(provider)
  const [moved] = nextProviders.splice(index, 1)
  nextProviders.splice(targetIndex, 0, moved)
  await persistProviderOrder(nextProviders, previousProviders)
}

// ── 加载 ──
async function loadProviders() {
  loading.value = true
  error.value = ''
  try {
    providers.value = await getProviders()
  } catch (e) {
    error.value = e.message || '加载失败'
  } finally {
    loading.value = false
  }
}

function getPreferredTestTarget(provider) {
  const chatModel = getDefaultModel(provider.model_map?.chat)
  if (chatModel) return { task: 'chat', model: chatModel, prompt: 'Hi' }
  const embeddingModel = getDefaultModel(provider.model_map?.embedding)
  if (embeddingModel) return { task: 'embedding', model: embeddingModel, prompt: '测试向量化' }
  return { task: 'chat', model: normalizeModelList(provider.models)[0] || '', prompt: 'Hi' }
}

// ── 测试 ──
async function quickTest(provider) {
  const key = getProviderKey(provider)
  testingKey.value = key
  testResults.value = { ...testResults.value, [key]: null }
  try {
    const target = getPreferredTestTarget(provider)
    const result = await testProvider(provider.name, target.model, target.prompt, provider.provider_type || '', target.task)
    if (result.error) throw new Error(result.error)
    const message = target.task === 'embedding'
      ? `Embedding 维度: ${result.embeddings?.[0]?.length || result.response?.embeddings?.[0]?.length || 0}`
      : `响应: ${(result.response?.content || result.content || '').slice(0, 60)}`
    testResults.value = {
      ...testResults.value,
      [key]: { ok: true, msg: message }
    }
    showToast('Provider 连通性测试成功', 'success')
  } catch (e) {
    const message = e.message || '测试失败'
    testResults.value = {
      ...testResults.value,
      [key]: { ok: false, msg: message }
    }
    showToast(message, 'error')
  } finally {
    testingKey.value = ''
  }
}

// ── Dialog 表单 ──
const dialog = ref({ visible: false, mode: 'create', error: '', saving: false })
const dialogPanelRef = ref(null)
const editingKey = ref('')
const form = ref({})
const modelMapEntries = ref([])

usePointerDownOutside({
  inside: [dialogPanelRef],
  enabled: () => dialog.value.visible,
  onOutside: closeDialog,
})

const apiEndpointPlaceholder = computed(() => {
  const providerType = form.value.provider_type
  return providerTypeMeta.value[providerType]?.default_endpoint || '由后端返回默认 API Endpoint'
})
const activeProviderConfigFields = computed(() => {
  const providerType = form.value.provider_type
  return providerTypeMeta.value[providerType]?.config_fields || []
})

function buildFormDefaults() {
  return {
    name: '', provider_type: '', api_key: '', api_endpoint: '',
    temperature: 0.7, max_completion_tokens: 4096,
    max_context_tokens: 128000, timeout: 60
  }
}

function openCreateDialog() {
  form.value = buildFormDefaults()
  modelMapEntries.value = [{ task: 'chat', model: '' }]
  dialog.value = { visible: true, mode: 'create', error: '', saving: false }
  editingKey.value = ''
}

function openEditDialog(provider) {
  const mm = provider.model_map || {}
  modelMapEntries.value = Object.entries(mm).flatMap(([task, value]) => {
    const models = normalizeModelList(value)
    return models.length
      ? models.map(model => ({ task, model }))
      : [{ task, model: '' }]
  })
  if (modelMapEntries.value.length === 0) modelMapEntries.value = [{ task: 'chat', model: '' }]
  const nextForm = {
    provider_type: provider.provider_type || '',
    api_key: '',
    api_endpoint: provider.api_endpoint || '',
    temperature: provider.temperature ?? 0.7,
    max_completion_tokens: provider.max_completion_tokens || 4096,
    max_context_tokens: provider.max_context_tokens || 128000,
    timeout: provider.timeout || 60
  }
  for (const field of getProviderConfigFields(nextForm.provider_type)) {
    nextForm[field.key] = provider[field.key] ?? field.default ?? ''
  }
  form.value = nextForm
  editingKey.value = getProviderKey(provider)
  dialog.value = { visible: true, mode: 'edit', error: '', saving: false }
}

function handleProviderTypeChange(providerType) {
  const previousType = form.value.provider_type
  const previousDefault = providerTypeMeta.value[previousType]?.default_endpoint || ''
  const nextDefault = providerTypeMeta.value[providerType]?.default_endpoint || ''
  const previousFields = getProviderConfigFields(previousType)
  const nextFields = getProviderConfigFields(providerType)

  form.value.provider_type = providerType

  if (!form.value.api_endpoint || form.value.api_endpoint === previousDefault) {
    form.value.api_endpoint = nextDefault
  }

  for (const field of previousFields) {
    if (!nextFields.some(item => item.key === field.key)) {
      delete form.value[field.key]
    }
  }

  for (const field of nextFields) {
    const previousFieldDefault = previousFields.find(item => item.key === field.key)?.default
    if (form.value[field.key] === undefined || form.value[field.key] === previousFieldDefault) {
      form.value[field.key] = field.default ?? ''
    }
  }
}

function closeDialog() {
  dialog.value.visible = false
}

function addModelMapEntry() {
  modelMapEntries.value.push({ task: '', model: '' })
}

function removeModelMapEntry(idx) {
  modelMapEntries.value.splice(idx, 1)
}

function buildModelMap() {
  const grouped = {}
  for (const entry of modelMapEntries.value) {
    const task = String(entry.task || '').trim()
    const model = String(entry.model || '').trim()
    if (!task || !model) continue
    if (!grouped[task]) grouped[task] = []
    if (!grouped[task].includes(model)) grouped[task].push(model)
  }

  return Object.fromEntries(
    Object.entries(grouped).map(([task, models]) => [
      task,
      models.length === 1 ? models[0] : models
    ])
  )
}

function getProviderConfigFields(providerType) {
  return providerTypeMeta.value[providerType]?.config_fields || []
}

function normalizeProviderPayload(payload) {
  for (const field of getProviderConfigFields(payload.provider_type)) {
    const value = payload[field.key]
    if (value === '' || value === null || value === undefined) {
      delete payload[field.key]
    }
  }
  return payload
}

async function handleSubmit() {
  dialog.value.error = ''
  if (dialog.value.mode === 'create') {
    if (!form.value.name?.trim()) { dialog.value.error = '请填写名称'; return }
    if (!form.value.provider_type) { dialog.value.error = '请选择 Provider 类型'; return }
    if (!form.value.api_key?.trim()) { dialog.value.error = '请填写 API Key'; return }
  }
  dialog.value.saving = true
  try {
    const mm = buildModelMap()
    const isCreate = dialog.value.mode === 'create'
    if (isCreate) {
      const payload = normalizeProviderPayload({ ...form.value, model_map: mm })
      await createProvider(payload)
    } else {
      const payload = normalizeProviderPayload({ ...form.value, model_map: mm })
      if (!payload.api_key?.trim()) delete payload.api_key
      await updateProvider(editingKey.value, payload)
    }
    closeDialog()
    await loadProviders()
    showToast(isCreate ? 'Provider 创建成功' : 'Provider 更新成功', 'success')
  } catch (e) {
    const message = e.message || '操作失败'
    dialog.value.error = message
    showToast(message, 'error')
  } finally {
    dialog.value.saving = false
  }
}

// ── 删除 ──
function confirmDelete(provider) {
  deleteTarget.value = provider
}

async function doDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    const key = getProviderKey(deleteTarget.value)
    await deleteProvider(key)
    deleteTarget.value = null
    await loadProviders()
    showToast('Provider 删除成功', 'success')
  } catch (e) {
    showToast(e.message || '删除失败', 'error')
  } finally {
    deleting.value = false
  }
}

onMounted(() => {
  loadProviderTypes()
  loadProviders()
})
</script>

<style scoped>
/* ── 统计卡片 ──────────────────────────────────────── */
.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}
@media (max-width: 900px) { .summary-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 480px) { .summary-grid { grid-template-columns: 1fr; } }

.summary-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 20px;
}
.summary-icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-secondary);
}
.summary-icon--total,
.summary-icon--openai,
.summary-icon--types,
.summary-icon--embedding { background: var(--color-interactive); color: var(--color-text-secondary); }

.summary-label { font-size: 0.78rem; color: var(--color-text-secondary); display: block; }
.summary-value { font-size: 1.5rem; font-weight: 700; color: var(--color-text-primary); }
.summary-value--connected { color: #34d399; }
.summary-value--enabled   { color: #fbbf24; }
.summary-value--tools     { color: #a78bfa; }

/* ── TeamBuilder 风格区块 ──────────────────────────── */
.builder-panel {
  position: relative;
  overflow: visible;
  padding: 20px;
  border-radius: 20px;
}

.section-toolbar,
.inline-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.inline-actions--wrap {
  justify-content: flex-start;
}

.section-toolbar {
  margin-bottom: 16px;
}

.toolbar-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.section-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text-primary);
}

.section-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

/* ── Provider 列表 ─────────────────────────────────── */
.provider-list-section {
  min-height: 200px;
}

.reorder-status {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.reorder-status--error {
  color: var(--color-error);
}

/* ── Provider 行式列表 ─────────────────────────────── */
.provider-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-row {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 12px 0 0;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid rgba(var(--color-border-rgb, 148,163,184), 0.56);
  background: rgba(var(--color-bg-elevated-rgb), 0.46);
  box-shadow: inset 0 1px 0 var(--color-soft-inset);
  transition: transform 0.22s cubic-bezier(.2,.8,.2,1);
}

.provider-row--dragging {
  opacity: 0;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

.provider-row--dragging > * {
  visibility: hidden;
}

.provider-row-drag-image {
  opacity: 1;
}

.provider-row-drag-image > * {
  visibility: visible;
}

.provider-row-list-move,
.provider-row-list-enter-active,
.provider-row-list-leave-active {
  transition: transform 0.28s cubic-bezier(.2,.8,.2,1);
  will-change: transform;
}

.provider-row-list-enter-from,
.provider-row-list-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.provider-row-main {
  display: grid;
  grid-template-columns: 72px minmax(280px, 1fr) auto;
  gap: 12px;
  align-items: stretch;
  min-width: 0;
  min-height: 62px;
}

.drag-handle {
  height: 100%;
  min-height: 62px;
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 72px;
  border: none;
  border-radius: 0;
  background: rgba(var(--color-bg-elevated-rgb), 0.24);
  color: var(--color-text-muted);
  cursor: grab;
  transition: background 0.16s ease, color 0.16s ease;
}

.drag-handle:hover:not(:disabled) {
  color: var(--color-text-secondary);
  background: rgba(var(--color-bg-elevated-rgb), 0.38);
}

.drag-handle:active:not(:disabled) {
  cursor: grabbing;
}

.drag-handle:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.order-index {
  min-width: 18px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.04em;
  color: inherit;
  text-align: right;
}

.provider-identity {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  min-width: 0;
}

.provider-title-line {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.provider-name {
  min-width: 0;
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-title-divider {
  width: 1px;
  height: 14px;
  flex-shrink: 0;
  background: rgba(var(--color-border-rgb, 148,163,184), 0.62);
}

.provider-type-text {
  flex-shrink: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.provider-endpoint {
  display: flex;
  align-items: center;
  min-width: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-row-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
  flex-wrap: nowrap;
}

.mono { font-family: inherit; }
.provider-test-result {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-left: 80px;
  padding: 9px 11px;
  border-radius: 13px;
  border: 1px solid transparent;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}

.result--ok  {
  background: rgba(var(--color-success-rgb), 0.08);
  border-color: rgba(var(--color-success-rgb), 0.18);
  color: var(--color-success);
}

.result--err {
  background: rgba(var(--color-error-rgb), 0.08);
  border-color: rgba(var(--color-error-rgb), 0.18);
  color: var(--color-error);
}

.result-icon {
  flex-shrink: 0;
  font-weight: 700;
}

.result-msg {
  min-width: 0;
}

.act-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  padding: 0 10px;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.18s ease, background 0.18s ease, color 0.18s ease;
}

.act-btn:hover:not(:disabled) {
  background: var(--color-hover-overlay);
}

.act-btn--test:hover:not(:disabled) {
  border-color: rgba(var(--color-success-rgb), 0.28);
  color: var(--color-success);
}

.act-btn--danger:hover:not(:disabled) {
  border-color: rgba(var(--color-error-rgb), 0.28);
  color: var(--color-error);
}

.act-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* ── Buttons ──────────────────────────────────────── */
.btn-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xs);
  min-height: 40px;
  padding: 0 18px;
  border-radius: 8px;
  border: 1px solid var(--color-brand-accent);
  background: var(--color-brand-accent);
  color: var(--color-on-color);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease, opacity 0.18s ease;
  white-space: nowrap;
}

.btn-primary:hover:not(:disabled) {
  border-color: var(--color-brand-accent-light);
  background: var(--color-brand-accent-light);
  box-shadow: none;
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-secondary,
.btn-danger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: 0 18px;
  border-radius: 999px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease, border-color 0.15s ease;
}

.btn-secondary {
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-primary);
}

.btn-secondary:hover {
  background: var(--color-hover-overlay);
}

.btn-danger {
  border: none;
  background: var(--color-error);
  color: var(--color-on-color);
}

.btn-danger:hover:not(:disabled) { opacity: .85; }
.btn-danger:disabled { opacity: .5; cursor: not-allowed; }

.icon-btn {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid var(--color-border);
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease, color .15s ease;
  color: var(--color-text-secondary);
}

.icon-btn:hover { background: var(--color-interactive-hover); }
.icon-btn--delete:hover { color: var(--color-error); border-color: rgba(var(--color-error-rgb), 0.22); }
.icon-btn:disabled { opacity: .4; cursor: not-allowed; }

.btn-add-row {
  background: none;
  border: 1px dashed var(--color-border);
  color: var(--color-text-muted);
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 0.82rem;
  cursor: pointer;
  transition: border-color .15s ease, color .15s ease, background .15s ease;
  width: 100%;
  margin-top: 4px;
}

.btn-add-row:hover {
  border-color: var(--color-brand-accent);
  color: var(--color-brand-accent);
  background: rgba(var(--color-brand-accent-rgb), 0.05);
}

/* ── Dialog ──────────────────────────────────────── */
.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 16px;
}

.dialog-panel {
  width: 100%;
  max-width: 720px;
  max-height: 90vh;
  overflow-y: auto;
  border-radius: 20px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.dialog-panel--sm { max-width: 420px; }

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dialog-header h2 {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--color-text-primary);
}

.dialog-close {
  background: none;
  border: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 8px;
  display: flex;
  align-items: center;
}

.dialog-close:hover { color: var(--color-text-primary); }

.dialog-form {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.dialog-form-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border-radius: 18px;
  border: 1px solid var(--color-border);
  background: var(--color-hover-overlay);
}

.dialog-form-section__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dialog-form-section__head h3 {
  margin: 0;
  font-size: 15px;
  color: var(--color-text-primary);
}

.dialog-form-section__head p {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.dialog-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 16px;
}

.dialog-form-grid__full {
  grid-column: 1 / -1;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 4px;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-size: 0.83rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.required { color: var(--color-error, #f87171); }

.form-control {
  width: 100%;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-family: inherit;
  transition: all 0.2s;
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
  outline: none;
}

.form-control:hover { border-color: var(--color-border-hover); }

.form-control:focus {
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.16);
}

.form-control:disabled {
  color: var(--color-text-muted);
  background: var(--color-bg-secondary);
  cursor: not-allowed;
  opacity: 0.6;
}

input[type='number'].form-control { padding-right: 8px; }
.form-control--sm { max-width: 110px; }

.form-hint {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  margin: 0;
}

.form-hint--section {
  margin-bottom: 4px;
}

.form-hint code {
  background: var(--color-hover-overlay, rgba(255,255,255,.08));
  padding: 1px 4px;
  border-radius: 3px;
  font-family: monospace;
}

.form-section-title {
  font-size: 0.83rem;
  font-weight: 700;
  color: var(--color-text-primary);
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 6px;
}

.form-error {
  color: var(--color-error, #f87171);
  font-size: 0.83rem;
  padding: 10px 12px;
  background: rgba(var(--color-error-rgb), .1);
  border: 1px solid rgba(var(--color-error-rgb), .18);
  border-radius: 14px;
}

.dialog-panel :deep(.select-trigger) {
  min-height: 44px;
  padding: 0 40px 0 14px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 500;
  transition: all 0.2s;
}

.dialog-panel :deep(.select-trigger:hover) {
  border-color: var(--color-border-hover);
}

.dialog-panel :deep(.select-trigger.open) {
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.16);
}

.model-map-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.model-map-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.map-arrow {
  color: var(--color-text-muted);
  font-size: 14px;
  flex-shrink: 0;
}

.delete-confirm-msg {
  margin: 0;
  color: var(--color-text-secondary);
  line-height: 1.7;
}

/* ── Spinner ──────────────────────────────────────── */
.spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-brand-accent-light);
  animation: spin .7s linear infinite;
}

.spinner--sm {
  width: 14px;
  height: 14px;
}

.spin { animation: spin .7s linear infinite; }

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── glass-card fallback ──────────────────────────── */
.glass-card {
  background: var(--glass-bg-light);
  border: 1px solid var(--color-glass-border);
  border-radius: 14px;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

@media (max-width: 1100px) {
  .provider-row-main {
    grid-template-columns: 72px minmax(260px, 1fr) auto;
  }
}

@media (max-width: 900px) {
  .provider-row-main {
    grid-template-columns: 72px minmax(0, 1fr);
    align-items: stretch;
  }

  .provider-row-actions,
  .provider-test-result {
    grid-column: 2;
    margin-left: 0;
    padding-left: 0;
  }

  .provider-row-actions {
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  .dialog-form-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .builder-panel,
  .dialog-panel {
    padding: 16px;
  }

  .provider-row {
    padding: 0 12px 12px 0;
  }

  .provider-row-main {
    grid-template-columns: 1fr;
  }

  .drag-handle,
  .provider-identity,
  .provider-row-actions,
  .provider-test-result {
    grid-column: 1;
  }

  .drag-handle {
    width: calc(100% + 12px);
    min-height: 36px;
    flex-direction: row;
    justify-content: flex-start;
    padding: 0 12px;
    border-right: 0;
    border-bottom: 1px solid rgba(var(--color-border-rgb, 148,163,184), 0.38);
  }

  .provider-row-actions {
    flex-wrap: wrap;
  }

  .dialog-footer {
    flex-direction: column-reverse;
  }

  .dialog-footer > * {
    width: 100%;
  }
}
</style>
