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
      <section class="summary-grid">
        <article class="summary-card glass-card">
          <div class="summary-icon summary-icon--total">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
            </svg>
          </div>
          <div class="summary-body">
            <span class="summary-label">Provider 总数</span>
            <strong class="summary-value">{{ providers.length }}</strong>
          </div>
        </article>
        <article class="summary-card glass-card">
          <div class="summary-icon summary-icon--openai">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </div>
          <div class="summary-body">
            <span class="summary-label">可用模型数</span>
            <strong class="summary-value summary-value--connected">{{ totalModels }}</strong>
          </div>
        </article>
        <article class="summary-card glass-card">
          <div class="summary-icon summary-icon--types">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 6h16M4 12h16M4 18h7"/>
            </svg>
          </div>
          <div class="summary-body">
            <span class="summary-label">Provider 类型</span>
            <strong class="summary-value summary-value--enabled">{{ uniqueTypes }}</strong>
          </div>
        </article>
        <article class="summary-card glass-card">
          <div class="summary-icon summary-icon--embedding">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/>
              <circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>
            </svg>
          </div>
          <div class="summary-body">
            <span class="summary-label">支持 Embedding</span>
            <strong class="summary-value summary-value--tools">{{ embeddingCount }}</strong>
          </div>
        </article>
      </section>

      <!-- ── Provider 列表 ──────────────────────────────── -->
      <section class="provider-list-section glass-card builder-panel">
        <div class="section-toolbar">
          <div class="toolbar-left">
            <h2 class="section-title">Provider 列表</h2>
            <p class="section-desc">查看 Provider 配置、模型映射与连通性测试结果，统一管理模型接入实例。</p>
          </div>
          <div class="inline-actions">
            <button class="pl-btn" :disabled="loading" @click="loadProviders">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" :class="{ spin: loading }">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
              {{ loading ? '刷新中...' : '刷新列表' }}
            </button>
          </div>
        </div>

        <div v-if="loading && providers.length === 0" class="state-panel">
          <div class="spinner"></div>
          <p>加载中...</p>
        </div>
        <div v-else-if="error" class="state-panel state-panel--error">
          <p>{{ error }}</p>
          <button class="btn-secondary" @click="loadProviders">重试</button>
        </div>
        <div v-else-if="providers.length === 0" class="state-panel state-panel--empty">
          <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
          </svg>
          <p>暂无 Provider，点击右上角“添加 Provider”开始配置</p>
        </div>
        <div v-else class="provider-grid">
          <article
            v-for="provider in providers"
            :key="provider.key || provider.name"
            class="provider-card"
          >
            <div class="provider-card-header">
              <div class="provider-card-heading">
                <div class="provider-info">
                  <span class="provider-type-badge" :class="`badge--${provider.provider_type}`">
                    {{ provider.provider_type || 'custom' }}
                  </span>
                  <h3 class="provider-name">{{ provider.name || provider.key }}</h3>
                </div>
                <div class="provider-subtitle mono">{{ provider.key || `${provider.name}_${provider.provider_type}` }}</div>
              </div>
            </div>

            <div class="provider-meta-row">
              <div class="meta-chip">
                <span class="meta-chip-label">类型</span>
                <span class="meta-chip-value meta-chip-value--mono">{{ provider.provider_type || 'custom' }}</span>
              </div>
              <div class="meta-chip">
                <span class="meta-chip-label">模型</span>
                <span class="meta-chip-value">{{ provider.models?.length || 0 }}</span>
              </div>
              <div class="meta-chip">
                <span class="meta-chip-label">Embedding</span>
                <span class="meta-chip-value" :class="hasModelMapValue(provider.model_map?.embedding) ? 'text-success' : 'text-muted'">
                  {{ hasModelMapValue(provider.model_map?.embedding) ? '支持' : '未配置' }}
                </span>
              </div>
              <div class="meta-chip">
                <span class="meta-chip-label">温度</span>
                <span class="meta-chip-value">{{ provider.temperature ?? '—' }}</span>
              </div>
            </div>

            <div class="provider-card-body">
              <div v-if="provider.api_endpoint" class="info-block">
                <span class="info-label">Endpoint</span>
                <code class="info-code">{{ provider.api_endpoint }}</code>
              </div>
              <div v-if="provider.model_map" class="info-block">
                <span class="info-label">模型映射</span>
                <div class="model-map-chips">
                  <span v-for="(model, task) in provider.model_map" :key="task" class="chip">
                    {{ task }}: {{ formatModelMapValue(model) }}
                  </span>
                </div>
              </div>
              <div v-if="provider.models && provider.models.length" class="info-block">
                <span class="info-label">所有模型</span>
                <div class="model-map-chips">
                  <span v-for="m in provider.models.slice(0, 4)" :key="m" class="chip chip--model">{{ m }}</span>
                  <span v-if="provider.models.length > 4" class="chip chip--more">+{{ provider.models.length - 4 }}</span>
                </div>
              </div>
            </div>

            <div v-if="testResults[provider.key || provider.name]" class="provider-test-result"
              :class="testResults[provider.key || provider.name].ok ? 'result--ok' : 'result--err'">
              <span class="result-icon">{{ testResults[provider.key || provider.name].ok ? '✓' : '✗' }}</span>
              <span class="result-msg">{{ testResults[provider.key || provider.name].msg }}</span>
            </div>

            <div class="provider-actions-bar inline-actions inline-actions--wrap">
              <button class="act-btn act-btn--test"
                :disabled="testingKey === (provider.key || provider.name)"
                @click="quickTest(provider)">
                <div v-if="testingKey === (provider.key || provider.name)" class="spinner spinner--sm"></div>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                {{ testingKey === (provider.key || provider.name) ? '测试中...' : '测试' }}
              </button>
              <button class="act-btn" @click="openEditDialog(provider)">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                编辑
              </button>
              <button class="act-btn act-btn--danger" @click="confirmDelete(provider)">
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
          </article>
        </div>
      </section>

    <!-- ── 新增/编辑 Dialog ──────────────────────────────── -->
    <div v-if="dialog.visible" class="dialog-backdrop">
      <div ref="dialogPanelRef" class="dialog-panel glass-card">
        <div class="dialog-header">
          <h2>{{ dialog.mode === 'create' ? '添加 Provider' : '编辑 Provider' }}</h2>
          <button class="dialog-close" @click="closeDialog">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <form class="dialog-form" @submit.prevent="handleSubmit">
          <section class="dialog-form-section">
            <div class="dialog-form-section__head">
              <h3>基础配置</h3>
              <p>填写 Provider 标识、鉴权信息与基础接入地址。</p>
            </div>
            <div class="dialog-form-grid">
              <!-- 基础字段（仅新建时可改） -->
              <div class="form-row" v-if="dialog.mode === 'create'">
                <label class="form-label">名称 <span class="required">*</span></label>
                <input v-model="form.name" class="form-control" placeholder="例如: my_gpt" />
                <p class="form-hint">Provider 实例的唯一名称，不可包含空格</p>
              </div>
              <div class="form-row" v-if="dialog.mode === 'create'">
                <label class="form-label">Provider 类型 <span class="required">*</span></label>
                <CustomSelect
                  :model-value="form.provider_type"
                  :options="providerTypeOptions"
                  placeholder="-- 请选择 --"
                  @update:model-value="handleProviderTypeChange"
                />
              </div>
              <div class="form-row dialog-form-grid__full">
                <label class="form-label">API Key <span v-if="dialog.mode === 'create'" class="required">*</span></label>
                <input v-model="form.api_key" class="form-control" type="password"
                  :placeholder="dialog.mode === 'create' ? 'sk-... 或 ${ENV_VAR}' : '留空则保持当前 API Key'" autocomplete="new-password" />
                <p class="form-hint">
                  {{ dialog.mode === 'create' ? '支持 ${ENV_VAR} 形式引用环境变量' : '仅在需要替换密钥时填写；留空表示保持当前值' }}
                </p>
              </div>
              <div class="form-row dialog-form-grid__full">
                <label class="form-label">API Endpoint</label>
                <input v-model="form.api_endpoint" class="form-control"
                  :placeholder="apiEndpointPlaceholder" />
              </div>
            </div>
          </section>

          <section class="dialog-form-section">
            <div class="dialog-form-section__head">
              <h3>运行参数</h3>
              <p>配置温度、token 上限与超时时间等运行时参数。</p>
            </div>
            <div class="dialog-form-grid">
              <div class="form-row">
                <label class="form-label">温度</label>
                <input v-model.number="form.temperature" class="form-control" type="number"
                  step="0.1" min="0" max="2" placeholder="0.7" />
              </div>
              <div class="form-row">
                <label class="form-label">Max Completion Tokens</label>
                <input v-model.number="form.max_completion_tokens" class="form-control" type="number"
                  step="256" min="256" placeholder="4096" />
              </div>
              <div class="form-row">
                <label class="form-label">Max Context Tokens</label>
                <input v-model.number="form.max_context_tokens" class="form-control" type="number"
                  step="1024" min="1024" placeholder="128000" />
              </div>
              <div class="form-row">
                <label class="form-label">Timeout (s)</label>
                <input v-model.number="form.timeout" class="form-control" type="number"
                  step="5" min="5" placeholder="60" />
              </div>
            </div>
          </section>

          <section class="dialog-form-section">
            <div class="dialog-form-section__head">
              <h3>模型与扩展</h3>
              <p>管理 Provider 的扩展字段与任务模型映射。</p>
            </div>

            <template v-if="activeProviderConfigFields.length > 0">
              <div class="form-section-title">Provider 扩展配置</div>
              <div class="dialog-form-grid">
                <div
                  v-for="field in activeProviderConfigFields"
                  :key="field.key"
                  class="form-row"
                >
                  <label class="form-label">{{ field.label }}</label>
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
                    class="form-control"
                    type="number"
                    :step="field.step || 1"
                    :min="field.min"
                    :max="field.max"
                    :placeholder="field.placeholder || ''"
                  />
                  <input
                    v-else
                    v-model="form[field.key]"
                    class="form-control"
                    :type="field.type === 'password' ? 'password' : 'text'"
                    :placeholder="field.placeholder || ''"
                  />
                  <p v-if="field.help" class="form-hint">{{ field.help }}</p>
                </div>
              </div>
            </template>

            <div class="form-section-title">模型映射 (model_map)</div>
            <p class="form-hint form-hint--section">按任务类型指定模型名，如 chat / embedding</p>
            <div class="model-map-editor">
              <div v-for="(entry, idx) in modelMapEntries" :key="idx" class="model-map-row">
                <input v-model="entry.task" class="form-control form-control--sm" placeholder="chat" />
                <span class="map-arrow">→</span>
                <input v-model="entry.model" class="form-control" placeholder="gpt-4o" />
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

          <div v-if="dialog.error" class="form-error">{{ dialog.error }}</div>

          <div class="dialog-footer">
            <button type="button" class="btn-secondary" @click="closeDialog">取消</button>
            <button type="submit" class="btn-primary" :disabled="dialog.saving">
              {{ dialog.saving ? '保存中...' : '保存' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- ── 删除确认 Dialog ───────────────────────────────── -->
    <div v-if="deleteTarget" class="dialog-backdrop">
      <div ref="deleteDialogPanelRef" class="dialog-panel dialog-panel--sm glass-card">
        <div class="dialog-header">
          <h2>确认删除</h2>
          <button class="dialog-close" @click="deleteTarget = null">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <p class="delete-confirm-msg">
          确定要删除 Provider <strong>{{ deleteTarget.key || deleteTarget.name }}</strong> 吗？此操作不可撤销。
        </p>
        <div class="dialog-footer">
          <button class="btn-secondary" @click="deleteTarget = null">取消</button>
          <button class="btn-danger" :disabled="deleting" @click="doDelete">
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
import PageLayout from '../components/PageLayout.vue'
import { usePointerDownOutside } from '../composables/usePointerDownOutside'
import {
  getProviderTypes,
  getProviders,
  createProvider,
  updateProvider,
  deleteProvider,
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

function formatModelMapValue(value) {
  return normalizeModelList(value).join(', ')
}

function getDefaultModel(value) {
  return normalizeModelList(value)[0] || ''
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
  const key = provider.key || provider.name
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
  editingKey.value = provider.key || `${provider.name}_${provider.provider_type}`
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
    const key = deleteTarget.value.key || `${deleteTarget.value.name}_${deleteTarget.value.provider_type}`
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
}
.summary-icon--total    { background: rgba(99,102,241,.15); color: #818cf8; }
.summary-icon--openai   { background: rgba(16,185,129,.15); color: #34d399; }
.summary-icon--types    { background: rgba(245,158,11,.15); color: #fbbf24; }
.summary-icon--embedding{ background: rgba(139,92,246,.15); color: #a78bfa; }

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

.provider-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

/* ── Provider Card ─────────────────────────────────── */
.provider-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border-radius: 18px;
  border: 1px solid var(--color-border);
  background: var(--color-hover-overlay);
  transition: border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
}

.provider-card:hover {
  border-color: rgba(var(--color-brand-accent-rgb), 0.28);
  box-shadow: inset 0 1px 0 var(--color-soft-inset);
}

.provider-card-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-card-heading {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.provider-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.provider-name {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--color-text-primary);
}

.provider-subtitle {
  font-size: 12px;
  color: var(--color-text-secondary);
  font-family: inherit;
  word-break: break-all;
}

.provider-type-badge {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 20px;
  text-transform: uppercase;
  letter-spacing: .04em;
  background: rgba(var(--color-text-muted-rgb, 107,114,128), .15);
  color: var(--color-text-secondary);
}

.badge--openai      { background: rgba(16,185,129,.18); color: #34d399; }
.badge--deepseek    { background: rgba(var(--color-brand-accent-rgb),.18); color: var(--color-brand-accent-light); }
.badge--openrouter  { background: rgba(245,158,11,.18); color: #fbbf24; }
.badge--modelscope  { background: rgba(236,72,153,.18); color: #f472b6; }
.badge--custom      { background: rgba(var(--color-border-rgb, 148,163,184), 0.18); color: var(--color-text-muted); }

.provider-meta-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.meta-chip {
  min-height: 56px;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb), 0.32);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.meta-chip-label {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.meta-chip-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.meta-chip-value--mono {
  font-family: inherit;
}

.text-success {
  color: var(--color-success);
}

.text-muted {
  color: var(--color-text-muted);
}

.provider-card-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.info-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.info-label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.info-code {
  display: block;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid rgba(var(--color-border-rgb, 148,163,184), 0.55);
  background: rgba(var(--color-bg-elevated-rgb), 0.18);
  color: var(--color-text-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-all;
}

.mono { font-family: inherit; }

.model-map-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  font-size: 12px;
  font-weight: 500;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  background: rgba(var(--color-brand-accent-rgb), 0.08);
  color: var(--color-text-secondary);
  font-family: inherit;
}

.chip--model {
  background: rgba(var(--color-success-rgb), 0.08);
  color: var(--color-text-primary);
}

.chip--more  {
  background: rgba(var(--color-border-rgb, 148,163,184), 0.12);
  color: var(--color-text-secondary);
}

.provider-test-result {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 14px;
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

.provider-actions-bar {
  margin-top: auto;
  padding-top: 4px;
}

.act-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 12px;
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-primary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
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
  border-radius: 999px;
  border: none;
  background: linear-gradient(135deg, rgba(var(--color-brand-accent-rgb), 0.9), rgba(var(--color-brand-accent-light-rgb), 0.95));
  color: var(--color-on-color);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
  transition: box-shadow 0.2s ease, transform 0.2s ease;
  white-space: nowrap;
}

.btn-primary:hover:not(:disabled) {
  box-shadow: 0 4px 14px rgba(var(--color-brand-accent-rgb), 0.35);
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

@media (max-width: 900px) {
  .provider-meta-row,
  .dialog-form-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .builder-panel,
  .dialog-panel {
    padding: 16px;
  }

  .provider-card {
    padding: 16px;
  }

  .provider-grid {
    grid-template-columns: 1fr;
  }

  .dialog-footer {
    flex-direction: column-reverse;
  }

  .dialog-footer > * {
    width: 100%;
  }
}
</style>
