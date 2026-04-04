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
      <section class="provider-list-section glass-card">
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
          <p>暂无 Provider，点击"添加 Provider"开始配置</p>
        </div>
        <div v-else class="provider-grid">
          <article
            v-for="provider in providers"
            :key="provider.key || provider.name"
            class="provider-card glass-card"
          >
            <div class="provider-card-header">
              <div class="provider-info">
                <span class="provider-type-badge" :class="`badge--${provider.provider_type}`">
                  {{ provider.provider_type || 'custom' }}
                </span>
                <h3 class="provider-name">{{ provider.name || provider.key }}</h3>
              </div>
              <div class="provider-actions">
                <button class="icon-btn icon-btn--test"
                  :disabled="testingKey === (provider.key || provider.name)"
                  @click="quickTest(provider)"
                  title="快速测试">
                  <svg v-if="testingKey !== (provider.key || provider.name)"
                    xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                  <div v-else class="spinner spinner--sm"></div>
                </button>
                <button class="icon-btn icon-btn--edit" @click="openEditDialog(provider)" title="编辑">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
                <button class="icon-btn icon-btn--delete" @click="confirmDelete(provider)" title="删除">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    <path d="M10 11v6"/><path d="M14 11v6"/>
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                  </svg>
                </button>
              </div>
            </div>

            <div class="provider-card-body">
              <div class="info-row">
                <span class="info-label">Key</span>
                <span class="info-value mono">{{ provider.key || `${provider.name}_${provider.provider_type}` }}</span>
              </div>
              <div v-if="provider.api_endpoint" class="info-row">
                <span class="info-label">Endpoint</span>
                <span class="info-value mono text-ellipsis">{{ provider.api_endpoint }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">温度</span>
                <span class="info-value">{{ provider.temperature ?? '—' }}</span>
              </div>
              <div v-if="provider.model_map" class="info-row">
                <span class="info-label">模型映射</span>
                <div class="model-map-chips">
                  <span v-for="(model, task) in provider.model_map" :key="task" class="chip">
                    {{ task }}: {{ model }}
                  </span>
                </div>
              </div>
              <div v-if="provider.models && provider.models.length" class="info-row">
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
          </article>
        </div>
      </section>

    <!-- ── 新增/编辑 Dialog ──────────────────────────────── -->
    <div v-if="dialog.visible" class="dialog-backdrop" @click.self="closeDialog">
      <div class="dialog-panel glass-card">
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
          <div class="form-row">
            <label class="form-label">API Key <span v-if="dialog.mode === 'create'" class="required">*</span></label>
            <input v-model="form.api_key" class="form-control" type="password"
              :placeholder="dialog.mode === 'create' ? 'sk-... 或 ${ENV_VAR}' : '留空则保持当前 API Key'" autocomplete="new-password" />
            <p class="form-hint">
              {{ dialog.mode === 'create' ? '支持 ${ENV_VAR} 形式引用环境变量' : '仅在需要替换密钥时填写；留空表示保持当前值' }}
            </p>
          </div>

          <!-- 通用字段 -->
          <div class="form-row">
            <label class="form-label">API Endpoint</label>
            <input v-model="form.api_endpoint" class="form-control"
              :placeholder="apiEndpointPlaceholder" />
          </div>
          <div class="form-row form-row--half">
            <div>
              <label class="form-label">温度</label>
              <input v-model.number="form.temperature" class="form-control" type="number"
                step="0.1" min="0" max="2" placeholder="0.7" />
            </div>
            <div>
              <label class="form-label">Max Completion Tokens</label>
              <input v-model.number="form.max_completion_tokens" class="form-control" type="number"
                step="256" min="256" placeholder="4096" />
            </div>
          </div>
          <div class="form-row form-row--half">
            <div>
              <label class="form-label">Max Context Tokens</label>
              <input v-model.number="form.max_context_tokens" class="form-control" type="number"
                step="1024" min="1024" placeholder="128000" />
            </div>
            <div>
              <label class="form-label">Timeout (s)</label>
              <input v-model.number="form.timeout" class="form-control" type="number"
                step="5" min="5" placeholder="60" />
            </div>
          </div>

          <template v-if="activeProviderConfigFields.length > 0">
            <div class="form-section-title">Provider 扩展配置</div>
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
          </template>

          <!-- model_map -->
          <div class="form-section-title">模型映射 (model_map)</div>
          <p class="form-hint" style="margin-bottom:8px">按任务类型指定模型名，如 chat / embedding / reasoning</p>
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
    <div v-if="deleteTarget" class="dialog-backdrop" @click.self="deleteTarget = null">
      <div class="dialog-panel dialog-panel--sm glass-card">
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

  </PageLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import CustomSelect from '../components/CustomSelect.vue'
import PageLayout from '../components/PageLayout.vue'
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
const testingKey = ref('')
const testResults = ref({})
const deleteTarget = ref(null)
const deleting = ref(false)

// ── 统计 ──
const totalModels = computed(() =>
  providers.value.reduce((acc, p) => acc + (p.models?.length || 0), 0)
)
const uniqueTypes = computed(() =>
  new Set(providers.value.map(p => p.provider_type).filter(Boolean)).size
)
const embeddingCount = computed(() =>
  providers.value.filter(p => p.model_map?.embedding).length
)

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

// ── 测试 ──
async function quickTest(provider) {
  const key = provider.key || provider.name
  testingKey.value = key
  testResults.value = { ...testResults.value, [key]: null }
  try {
    const chatModel = provider.model_map?.chat || provider.models?.[0] || ''
    const result = await testProvider(provider.name, chatModel, 'Hi', provider.provider_type || '')
    if (result.error) throw new Error(result.error)
    testResults.value = {
      ...testResults.value,
      [key]: { ok: true, msg: `响应: ${(result.response?.content || result.content || '').slice(0, 60)}` }
    }
  } catch (e) {
    testResults.value = {
      ...testResults.value,
      [key]: { ok: false, msg: e.message || '测试失败' }
    }
  } finally {
    testingKey.value = ''
  }
}

// ── Dialog 表单 ──
const dialog = ref({ visible: false, mode: 'create', error: '', saving: false })
const editingKey = ref('')
const form = ref({})
const modelMapEntries = ref([])

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
  modelMapEntries.value = Object.entries(mm).map(([task, model]) => ({ task, model: String(model) }))
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
  const mm = {}
  for (const e of modelMapEntries.value) {
    if (e.task && e.model) mm[e.task.trim()] = e.model.trim()
  }
  return mm
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
    if (dialog.value.mode === 'create') {
      const payload = normalizeProviderPayload({ ...form.value, model_map: mm })
      await createProvider(payload)
    } else {
      const payload = normalizeProviderPayload({ ...form.value, model_map: mm })
      if (!payload.api_key?.trim()) delete payload.api_key
      await updateProvider(editingKey.value, payload)
    }
    closeDialog()
    await loadProviders()
  } catch (e) {
    dialog.value.error = e.message || '操作失败'
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
  } catch (e) {
    alert(e.message || '删除失败')
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

/* ── Provider 列表 ─────────────────────────────────── */
.provider-list-section {
  padding: 20px;
  min-height: 200px;
}
.provider-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 16px;
}

/* ── Provider Card ─────────────────────────────────── */
.provider-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--color-glass-border);
  border-radius: var(--radius-lg);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  transition: border-color 0.2s, box-shadow 0.2s;
}
.provider-card:hover {
  border-color: rgba(var(--color-brand-accent-rgb), 0.35);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
.provider-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.provider-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.provider-name {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--color-text-primary);
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
.badge--custom      { background: rgba(var(--color-border-hover, 255,255,255,.12), 1); color: var(--color-text-muted); }

.provider-actions {
  display: flex;
  gap: 4px;
}

.provider-card-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.82rem;
}
.info-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
}
.info-label {
  color: var(--color-text-muted);
  min-width: 70px;
  flex-shrink: 0;
  font-size: 0.78rem;
}
.info-value {
  color: var(--color-text-primary);
  word-break: break-all;
}
.mono { font-family: monospace; font-size: 0.78rem; }
.text-ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}

.model-map-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chip {
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: 20px;
  background: rgba(99,102,241,.15);
  color: #818cf8;
  font-family: monospace;
}
.chip--model { background: rgba(16,185,129,.12); color: #34d399; }
.chip--more  { background: rgba(107,114,128,.15); color: #9ca3af; }

.provider-test-result {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 0.8rem;
  word-break: break-all;
}
.result--ok  { background: rgba(16,185,129,.1); color: #34d399; }
.result--err { background: rgba(239,68,68,.1);  color: #f87171; }
.result-icon { flex-shrink: 0; font-weight: 700; }

/* ── Buttons ──────────────────────────────────────── */

.btn-primary {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-xs);
    /* height: 40px; */
    padding: var(--spacing-sm) var(--spacing-md);
    border-radius: 8px;
    border: none;
    background: linear-gradient(135deg, rgba(var(--color-brand-accent-rgb), 0.9), rgba(var(--color-brand-accent-light-rgb), 0.95));
    color: #fff;
    font: inherit;
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
}

.btn-primary:hover:not(:disabled) {
    /* transform: translateY(-1px); */
    box-shadow: 0 4px 14px rgba(var(--color-brand-accent-rgb), 0.35);
}

.btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.btn-secondary {
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-primary);
  font-size: 0.85rem;
  cursor: pointer;
  transition: background .15s;
}
.btn-secondary:hover { background: var(--color-hover-overlay); }

.btn-danger {
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  background: var(--color-error);
  color: #fff;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity .15s;
}
.btn-danger:hover:not(:disabled) { opacity: .85; }
.btn-danger:disabled { opacity: .5; cursor: not-allowed; }

.icon-btn {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background .15s;
  color: var(--color-text-secondary);
}
.icon-btn:hover { background: var(--color-interactive-hover); }
.icon-btn--test:hover  { color: #34d399; border-color: rgba(52,211,153,.3); }
.icon-btn--edit:hover  { color: #818cf8; border-color: rgba(129,140,248,.3); }
.icon-btn--delete:hover{ color: #f87171; border-color: rgba(248,113,113,.3); }
.icon-btn:disabled { opacity: .4; cursor: not-allowed; }

.btn-add-row {
  background: none;
  border: 1px dashed var(--color-border);
  color: var(--color-text-muted);
  border-radius: 6px;
  padding: 5px 12px;
  font-size: 0.82rem;
  cursor: pointer;
  transition: border-color .15s, color .15s;
  width: 100%;
  margin-top: 4px;
}
.btn-add-row:hover { border-color: var(--color-brand-accent); color: var(--color-brand-accent); }

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
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
  border-radius: 14px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dialog-panel--sm { max-width: 400px; }

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.dialog-header h2 {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--color-text-primary);
}
.dialog-close {
  background: none;
  border: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
}
.dialog-close:hover { color: var(--color-text-primary); }

.dialog-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
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
  gap: 5px;
}
.form-row--half {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.form-label {
  font-size: 0.83rem;
  font-weight: 600;
  color: var(--color-text-primary);
}
.required { color: var(--color-error, #f87171); }
.form-control {
  width: 100%;
  height: 42px;
  padding: 0 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
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
.form-control--sm { max-width: 100px; }
.form-hint {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  margin: 0;
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
  margin-top: 4px;
}
.form-error {
  color: var(--color-error, #f87171);
  font-size: 0.83rem;
  padding: 8px 12px;
  background: rgba(239,68,68,.1);
  border-radius: var(--radius-md);
}

/* form-control 补充：sm 宽度变体 */
.form-control--sm { max-width: 100px; }
input[type='number'].form-control { padding-right: 8px; }

/* dialog 内 CustomSelect 与 form-control 外观统一 */
.dialog-panel :deep(.select-trigger) {
  height: 42px;
  padding: 0 40px 0 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
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
  gap: 8px;
}
.model-map-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.map-arrow {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.delete-confirm-msg {
  font-size: 0.9rem;
  color: var(--color-text-primary);
  line-height: 1.5;
  margin: 0;
}

/* ── Spinner ──────────────────────────────────────── */
.spinner--sm {
  width: 14px;
  height: 14px;
  border-width: 2px;
}
.spin { animation: spin .7s linear infinite; }

/* ── glass-card fallback ──────────────────────────── */
.glass-card {
  background: var(--glass-bg-light);
  border: 1px solid var(--color-glass-border);
  border-radius: 14px;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
</style>
