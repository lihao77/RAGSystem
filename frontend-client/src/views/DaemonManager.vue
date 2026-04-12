<template>
  <PageLayout title="守护 Agent" subtitle="常驻守护系统 — 社交消息网关 · 定时调度 · 心跳监控" max-width="960px">
    <template #header-actions>
      <div class="header-actions">
        <button
          class="pl-btn"
          :class="status.running ? 'pl-btn--danger' : 'pl-btn--primary'"
          @click="toggleDaemon"
          :disabled="loading"
        >
          {{ loading ? '...' : (status.running ? '停止' : '启动') }}
        </button>
        <button class="pl-btn pl-btn--ghost" @click="refresh" :disabled="loading">
          刷新
        </button>
      </div>
    </template>

    <div class="daemon-content">
      <!-- 系统状态 -->
      <section class="section">
        <div class="section-head">
          <h2>系统状态</h2>
          <span class="badge" :class="statusBadgeClass">{{ statusBadgeText }}</span>
        </div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-value">{{ status.adapter_count || 0 }}</div>
            <div class="stat-label">已连接平台</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ cronTaskCount }}</div>
            <div class="stat-label">定时任务</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ status.daemon_sessions || 0 }}</div>
            <div class="stat-label">守护会话</div>
          </div>
        </div>
      </section>

      <!-- 基础配置 -->
      <section class="section">
        <div class="section-head">
          <h2>基础配置</h2>
          <button class="pl-btn pl-btn--primary" @click="saveBaseConfig" :disabled="baseSaving">
            {{ baseSaving ? '保存中...' : '保存配置' }}
          </button>
        </div>
        <div class="base-config-card">
          <div class="form-grid two-col">
            <div class="form-item">
              <label class="form-label">守护系统开关</label>
              <div class="switch-row">
                <span class="badge" :class="baseForm.enabled ? 'badge-success' : 'badge-neutral'">
                  {{ baseForm.enabled ? '已启用' : '未启用' }}
                </span>
                <div class="platform-config-toggle" @click="baseForm.enabled = !baseForm.enabled">
                  <span class="toggle-track" :class="{ 'toggle-track--on': baseForm.enabled }">
                    <span class="toggle-thumb" />
                  </span>
                </div>
              </div>
            </div>
            <div class="form-item">
              <label class="form-label">默认会话 TTL（秒）</label>
              <input v-model.number="baseForm.default_session_ttl" type="number" min="60" class="form-control" />
            </div>
            <div class="form-item">
              <label class="form-label">Team 名称</label>
              <input v-model="baseForm.team_name" class="form-control" placeholder="default" />
            </div>
            <div class="form-item">
              <label class="form-label">入口 Agent（留空用 team 默认）</label>
              <input v-model="baseForm.entry_agent" class="form-control" placeholder="留空则用 team 的 default_entry" />
            </div>
            <div class="form-item">
              <label class="form-label">心跳间隔（秒）</label>
              <input v-model.number="baseForm.heartbeat_interval" type="number" min="5" class="form-control" />
            </div>
          </div>
          <p class="section-tip">保存后，若守护系统正在运行，会自动重载并应用新配置。</p>
        </div>
      </section>

      <!-- 平台配置 -->
      <section class="section">
        <div class="section-head">
          <h2>平台配置</h2>
          <button class="act-btn act-btn--accent" @click="openAddPlatform">+ 添加平台</button>
        </div>
        <div v-if="platformConfigs.length" class="platform-config-grid">
          <div
            v-for="pc in platformConfigs"
            :key="pc.key"
            class="platform-config-card"
            :class="{ 'platform-config-card--active': pc.enabled }"
          >
            <div class="platform-config-head">
              <div class="platform-config-name">
                {{ platformLabel(pc.key) }}
              </div>
              <div class="platform-config-toggle" @click="togglePlatformEnabled(pc.key)">
                <span class="toggle-track" :class="{ 'toggle-track--on': pc.enabled }">
                  <span class="toggle-thumb" />
                </span>
              </div>
            </div>
            <div class="platform-config-body">
              <div class="platform-config-field">
                <span class="platform-config-label">App ID</span>
                <span class="platform-config-value">{{ mask(pc.app_id) || '未配置' }}</span>
              </div>
              <div class="platform-config-field">
                <span class="platform-config-label">App Secret</span>
                <span class="platform-config-value">{{ mask(pc.app_secret) || '未配置' }}</span>
              </div>
              <div v-if="pc.extra_fields.length" class="platform-config-extra">
                <div v-for="ef in pc.extra_fields" :key="ef.key" class="platform-config-field">
                  <span class="platform-config-label">{{ ef.label }}</span>
                  <span class="platform-config-value">{{ mask(ef.value) || '未配置' }}</span>
                </div>
              </div>
            </div>
            <div class="platform-config-actions">
              <button class="act-btn" @click="openEditPlatform(pc.key)">编辑</button>
              <button class="act-btn act-btn--danger" @click="removePlatform(pc.key)">移除</button>
            </div>
          </div>
        </div>
        <div v-else class="state-panel state-panel--empty">
          <p>暂无平台配置，点击右上角添加</p>
        </div>
      </section>

      <!-- 平台适配器状态 -->
      <section class="section">
        <div class="section-head"><h2>适配器状态</h2></div>
        <div class="adapter-grid">
          <div
            v-for="agent in agents"
            :key="agent.team_name"
            class="adapter-group"
          >
            <div class="adapter-group-title">{{ agent.team_name }}</div>
            <div class="adapter-cards">
              <div
                v-for="(info, platform) in agent.platforms"
                :key="platform"
                class="adapter-card"
                :class="{
                  'adapter-card--connected': info.status === 'connected',
                  'adapter-card--error': info.status === 'error'
                }"
              >
                <div class="adapter-platform">{{ platformLabel(platform) }}</div>
                <div class="adapter-status">
                  <span class="dot" :class="'dot-' + info.status"></span>
                  {{ statusLabel(info.status) }}
                </div>
                <button
                  v-if="info.enabled && info.status === 'connected'"
                  class="act-btn"
                  @click="openTestDialog(agent.team_name, platform)"
                >
                  测试
                </button>
              </div>
            </div>
          </div>
          <div v-if="!agents.length" class="state-panel state-panel--empty">
            <p>守护系统未运行或无适配器</p>
          </div>
        </div>
      </section>

      <!-- Cron 任务 -->
      <section class="section">
        <div class="section-head">
          <h2>定时任务</h2>
          <button class="act-btn act-btn--accent" @click="showAddTask = true">+ 新增</button>
        </div>
        <div class="cron-table-wrap">
          <table v-if="cronTasks.length" class="cron-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>Cron</th>
                <th>Agent</th>
                <th>推送</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="task in cronTasks" :key="task.task_id">
                <td>
                  <div class="task-name">{{ task.name || task.task_id }}</div>
                  <div class="task-desc">{{ taskDesc(task.task) }}</div>
                </td>
                <td><code class="cron-expr">{{ task.cron }}</code></td>
                <td>{{ task.team_name }}</td>
                <td>{{ task.push_platform ? platformLabel(task.push_platform) : '-' }}</td>
                <td>
                  <span class="badge" :class="task.enabled ? 'badge-success' : 'badge-neutral'">
                    {{ task.enabled ? '启用' : '禁用' }}
                  </span>
                </td>
                <td class="task-actions">
                  <button class="act-btn" @click="handleTriggerTask(task.task_id)" title="手动触发">&#9654;</button>
                  <button class="act-btn" @click="handleToggleTask(task)" title="切换状态">
                    {{ task.enabled ? '&#9208;' : '&#9654;' }}
                  </button>
                  <button class="act-btn act-btn--danger" @click="handleDeleteTask(task.task_id)" title="删除">&#10005;</button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="state-panel state-panel--empty">
            <p>暂无定时任务</p>
          </div>
        </div>
      </section>

      <!-- 主动推送 -->
      <section class="section">
        <div class="section-head"><h2>主动推送</h2></div>
        <div class="push-form">
          <div class="form-grid two-col">
            <select v-model="pushForm.platform" class="form-control">
              <option value="wechat">企业微信</option>
              <option value="dingtalk">钉钉</option>
              <option value="feishu">飞书</option>
            </select>
            <input v-model="pushForm.chat_id" class="form-control" placeholder="目标 chat_id（飞书请先通过入站消息获取）" />
          </div>
          <textarea v-model="pushForm.content" class="form-control" placeholder="推送内容" rows="2"></textarea>
          <button class="pl-btn pl-btn--primary" @click="handlePush" :disabled="pushSending">
            {{ pushSending ? '发送中...' : '发送' }}
          </button>
        </div>
      </section>
    </div>

    <!-- 平台配置编辑弹窗 -->
    <div v-if="showConfigModal" class="modal-backdrop" @click.self="showConfigModal = false">
      <div class="modal-shell modal-shell--narrow">
        <div class="modal-header">
          <h3>{{ isNewPlatform ? '添加平台' : '编辑配置' }} — {{ platformLabel(platformForm.key) }}</h3>
          <button class="modal-close" @click="showConfigModal = false">&#10005;</button>
        </div>
        <div class="modal-body">
          <div v-if="isNewPlatform" class="form-item">
            <label class="form-label">选择平台</label>
            <select v-model="platformForm.key" class="form-control">
              <option value="wechat">企业微信</option>
              <option value="dingtalk">钉钉</option>
              <option value="feishu">飞书</option>
            </select>
          </div>
          <div class="form-item">
            <label class="form-label">{{ fieldLabel('app_id') }}</label>
            <input v-model="platformForm.app_id" class="form-control" :placeholder="fieldPlaceholder('app_id')" />
          </div>
          <div class="form-item">
            <label class="form-label">{{ fieldLabel('app_secret') }}</label>
            <input v-model="platformForm.app_secret" class="form-control" type="password" :placeholder="fieldPlaceholder('app_secret')" />
          </div>
          <div v-if="platformForm.key === 'wechat'" class="form-item">
            <label class="form-label">企业 CorpID</label>
            <input v-model="platformForm.extra_corp_id" class="form-control" placeholder="ww1234567890abcdef" />
          </div>
          <div v-if="platformForm.key === 'dingtalk'" class="form-item">
            <label class="form-label">企业应用 AgentId</label>
            <input v-model="platformForm.extra_agent_id" class="form-control" placeholder="123456789" />
          </div>
          <div v-if="platformForm.key === 'feishu'" class="form-item">
            <label class="form-label">接收方式</label>
            <select v-model="platformForm.receive_mode" class="form-control">
              <option value="long_connection">长连接（推荐，无需公网）</option>
              <option value="webhook">Webhook（需要公网 HTTPS）</option>
            </select>
            <p class="section-tip">长连接模式下无需公网地址；Webhook 模式下需配置公网 HTTPS 回调地址。</p>
          </div>
          <div class="form-item">
            <label class="form-label">{{ platformForm.key === 'feishu' ? '事件订阅 Token（推荐）' : '回调 Token（可选）' }}</label>
            <input v-model="platformForm.token" class="form-control" :placeholder="platformForm.key === 'feishu' && platformForm.receive_mode === 'long_connection' ? '飞书事件订阅 Token' : '用于验证 webhook 消息来源'" />
          </div>
          <div class="form-item">
            <label class="form-label">{{ platformForm.key === 'feishu' ? 'Encrypt Key（可选）' : 'EncodingAESKey（可选）' }}</label>
            <input v-model="platformForm.encoding_aes_key" class="form-control" :placeholder="platformForm.key === 'feishu' && platformForm.receive_mode === 'long_connection' ? '未开启消息加密可留空' : '消息加解密密钥'" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="pl-btn pl-btn--ghost" @click="showConfigModal = false">取消</button>
          <button class="pl-btn pl-btn--primary" @click="savePlatformConfig" :disabled="configSaving">
            {{ configSaving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 新增 Cron 任务弹窗 -->
    <div v-if="showAddTask" class="modal-backdrop" @click.self="showAddTask = false">
      <div class="modal-shell modal-shell--narrow">
        <div class="modal-header">
          <h3>新增定时任务</h3>
          <button class="modal-close" @click="showAddTask = false">&#10005;</button>
        </div>
        <div class="modal-body">
          <div class="form-item">
            <label class="form-label">任务名称</label>
            <input v-model="newTask.name" class="form-control" placeholder="如：早间简报" />
          </div>
          <div class="form-item">
            <label class="form-label">Cron 表达式</label>
            <input v-model="newTask.cron" class="form-control" placeholder="0 9 * * 1-5" />
          </div>
          <div class="form-item">
            <label class="form-label">任务描述</label>
            <textarea v-model="newTask.task" class="form-control" placeholder="传给 Agent 的任务文本" rows="2"></textarea>
          </div>
          <div class="form-item">
            <label class="form-label">Team</label>
            <input v-model="newTask.team_name" class="form-control" placeholder="default" />
          </div>
          <div class="form-item">
            <label class="form-label">入口 Agent（可选）</label>
            <input v-model="newTask.entry_agent" class="form-control" placeholder="留空用 team 默认" />
          </div>
          <div class="form-grid two-col">
            <div class="form-item">
              <label class="form-label">推送平台（可选）</label>
              <select v-model="newTask.push_platform" class="form-control">
                <option :value="null">不推送</option>
                <option value="wechat">企业微信</option>
                <option value="dingtalk">钉钉</option>
                <option value="feishu">飞书</option>
              </select>
            </div>
            <div class="form-item">
              <label class="form-label">推送 chat_id</label>
              <input v-model="newTask.push_chat_id" class="form-control" placeholder="可选" />
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="pl-btn pl-btn--ghost" @click="showAddTask = false">取消</button>
          <button class="pl-btn pl-btn--primary" @click="handleAddTask">创建</button>
        </div>
      </div>
    </div>

    <!-- 测试消息弹窗 -->
    <div v-if="showTestDialog" class="modal-backdrop" @click.self="showTestDialog = false">
      <div class="modal-shell modal-shell--narrow">
        <div class="modal-header">
          <h3>测试消息 — {{ platformLabel(testTarget.platform) }}</h3>
          <button class="modal-close" @click="showTestDialog = false">&#10005;</button>
        </div>
        <div class="modal-body">
          <div class="form-item">
            <label class="form-label">Chat ID</label>
            <input v-model="testForm.chat_id" class="form-control" placeholder="真实 chat_id（飞书勿填 test_user）" />
          </div>
          <div class="form-item">
            <label class="form-label">消息内容</label>
            <input v-model="testForm.content" class="form-control" placeholder="测试消息" />
          </div>
        </div>
        <div class="modal-footer">
          <button class="pl-btn pl-btn--ghost" @click="showTestDialog = false">取消</button>
          <button class="pl-btn pl-btn--primary" @click="handleTest">发送</button>
        </div>
      </div>
    </div>
  </PageLayout>
</template>
<script setup>
import { ref, computed, onMounted } from 'vue'
import PageLayout from '../components/PageLayout.vue'
import * as api from '../api/daemon'

const loading = ref(false)
const status = ref({})
const agents = ref([])
const cronTasks = ref([])
const daemonConfig = ref(null)
const showAddTask = ref(false)
const showTestDialog = ref(false)
const showConfigModal = ref(false)
const configSaving = ref(false)
const baseSaving = ref(false)
const isNewPlatform = ref(false)

const baseForm = ref({
  enabled: false,
  default_session_ttl: 86400,
  team_name: 'default',
  entry_agent: '',
  heartbeat_interval: 30,
})

const testTarget = ref({ team_name: '', platform: '' })
const testForm = ref({ chat_id: '', content: '测试消息' })

const pushForm = ref({ platform: 'wechat', chat_id: '', content: '' })
const pushSending = ref(false)

const newTask = ref({
  name: '', cron: '', task: '', team_name: 'default', entry_agent: '',
  push_platform: null, push_chat_id: '',
})

const platformForm = ref({
  key: 'feishu',
  app_id: '', app_secret: '', token: '', encoding_aes_key: '',
  receive_mode: 'long_connection',
  extra_corp_id: '', extra_agent_id: '',
})

// ── 计算属性 ──

const statusBadgeClass = computed(() => {
  if (status.value.running) return 'badge-success'
  if (status.value.enabled) return 'badge-warning'
  return 'badge-neutral'
})

const statusBadgeText = computed(() => {
  if (status.value.running) return '运行中'
  if (status.value.enabled) return '已配置'
  return '未启用'
})

const cronTaskCount = computed(() => cronTasks.value.length)

const platformConfigs = computed(() => {
  const agent = daemonConfig.value?.agents?.[0]
  if (!agent) return []
  const platforms = agent.platforms || {}
  return Object.entries(platforms).map(([key, conn]) => {
    const extra = conn.extra || {}
    const extraFields = []
    if (key === 'wechat' && extra.corp_id !== undefined) {
      extraFields.push({ key: 'corp_id', label: 'Corp ID', value: extra.corp_id })
    }
    if (key === 'dingtalk' && extra.agent_id !== undefined) {
      extraFields.push({ key: 'agent_id', label: 'Agent ID', value: extra.agent_id })
    }
    if (key === 'feishu') {
      extraFields.push({ key: 'receive_mode', label: '接收方式', value: extra.receive_mode || 'webhook' })
    }
    return {
      key,
      enabled: conn.enabled,
      app_id: conn.app_id,
      app_secret: conn.app_secret,
      extra_fields: extraFields,
    }
  })
})

// ── 标签工具 ──

function platformLabel(p) {
  const map = { wechat: '企业微信', dingtalk: '钉钉', feishu: '飞书' }
  return map[p] || p
}

function statusLabel(s) {
  const map = { connected: '已连接', disconnected: '未连接', connecting: '连接中', error: '异常' }
  return map[s] || s
}

function taskDesc(text) {
  if (!text) return ''
  return text.length > 60 ? text.slice(0, 60) + '...' : text
}

function mask(val) {
  if (!val) return ''
  if (val.length <= 8) return '****'
  return val.slice(0, 4) + '****' + val.slice(-4)
}

const FIELD_LABELS = {
  wechat: { app_id: 'AgentId（应用 ID）', app_secret: '应用 Secret' },
  dingtalk: { app_id: 'AppKey', app_secret: 'AppSecret' },
  feishu: { app_id: 'App ID', app_secret: 'App Secret' },
}

function fieldLabel(field) {
  const labels = FIELD_LABELS[platformForm.value.key] || {}
  return labels[field] || field
}

function fieldPlaceholder(field) {
  if (field === 'app_id') {
    const map = { wechat: '1000002', dingtalk: 'dingxxxxxx', feishu: 'cli_xxxxxxxxxxxx' }
    return map[platformForm.value.key] || ''
  }
  if (field === 'app_secret') return '粘贴你的应用密钥'
  return ''
}

// ── 数据刷新 ──

async function refresh() {
  loading.value = true
  try {
    const [s, a, t, cfg] = await Promise.all([
      api.getStatus(),
      api.listAgents(),
      api.listCronTasks(),
      api.getConfig().catch(() => null),
    ])
    status.value = s
    agents.value = a
    cronTasks.value = t
    if (cfg) {
      daemonConfig.value = cfg
      const agent = cfg.agents?.[0]
      baseForm.value = {
        enabled: !!cfg.enabled,
        default_session_ttl: cfg.default_session_ttl || 86400,
        team_name: agent?.team_name || 'default',
        entry_agent: agent?.entry_agent || '',
        heartbeat_interval: agent?.heartbeat_interval || 30,
      }
    }
  } catch (e) {
    console.error('刷新失败:', e)
  } finally {
    loading.value = false
  }
}

// ── 守护系统控制 ──

async function toggleDaemon() {
  loading.value = true
  try {
    if (status.value.running) {
      await api.stopDaemon()
    } else {
      await api.startDaemon()
    }
    await refresh()
  } catch (e) {
    console.error('操作失败:', e)
  } finally {
    loading.value = false
  }
}

async function saveBaseConfig() {
  baseSaving.value = true
  try {
    const agent = ensureAgentEntry()
    daemonConfig.value.enabled = !!baseForm.value.enabled
    daemonConfig.value.default_session_ttl = Number(baseForm.value.default_session_ttl) || 86400
    agent.team_name = baseForm.value.team_name || 'default'
    agent.entry_agent = baseForm.value.entry_agent || null
    agent.heartbeat_interval = Math.max(5, Number(baseForm.value.heartbeat_interval) || 30)
    await api.updateConfig(daemonConfig.value)
    await refresh()
  } catch (e) {
    console.error('保存基础配置失败:', e)
  } finally {
    baseSaving.value = false
  }
}

// ── 平台配置 ──

function ensureAgentEntry() {
  if (!daemonConfig.value) daemonConfig.value = { enabled: true, agents: [], default_session_ttl: 86400 }
  if (!daemonConfig.value.agents.length) {
    daemonConfig.value.agents.push({
      team_name: 'default', entry_agent: null, enabled: true,
      platforms: {}, cron_tasks: [], heartbeat_interval: 30,
    })
  }
  return daemonConfig.value.agents[0]
}

function openAddPlatform() {
  isNewPlatform.value = true
  platformForm.value = {
    key: 'feishu', app_id: '', app_secret: '',
    token: '', encoding_aes_key: '', receive_mode: 'long_connection', extra_corp_id: '', extra_agent_id: '',
  }
  showConfigModal.value = true
}

function openEditPlatform(platformKey) {
  isNewPlatform.value = false
  const agent = daemonConfig.value?.agents?.[0]
  const conn = agent?.platforms?.[platformKey] || {}
  platformForm.value = {
    key: platformKey,
    app_id: conn.app_id || '',
    app_secret: conn.app_secret || '',
    token: conn.token || '',
    encoding_aes_key: conn.encoding_aes_key || '',
    receive_mode: conn.extra?.receive_mode || (platformKey === 'feishu' ? 'long_connection' : 'webhook'),
    extra_corp_id: conn.extra?.corp_id || '',
    extra_agent_id: conn.extra?.agent_id || '',
  }
  showConfigModal.value = true
}

async function savePlatformConfig() {
  configSaving.value = true
  try {
    const agent = ensureAgentEntry()
    const f = platformForm.value
    const extra = { ...agent.platforms[f.key]?.extra }
    if (f.key === 'wechat' && f.extra_corp_id) extra.corp_id = f.extra_corp_id
    if (f.key === 'dingtalk' && f.extra_agent_id) extra.agent_id = f.extra_agent_id
    if (f.key === 'feishu') extra.receive_mode = f.receive_mode || 'long_connection'

    agent.platforms[f.key] = {
      enabled: true,
      app_id: f.app_id || null,
      app_secret: f.app_secret || null,
      token: f.token || null,
      encoding_aes_key: f.encoding_aes_key || null,
      extra,
    }

    await api.updateConfig(daemonConfig.value)
    showConfigModal.value = false
    await refresh()
  } catch (e) {
    console.error('保存配置失败:', e)
  } finally {
    configSaving.value = false
  }
}

async function togglePlatformEnabled(platformKey) {
  const agent = daemonConfig.value?.agents?.[0]
  if (!agent?.platforms?.[platformKey]) return
  agent.platforms[platformKey].enabled = !agent.platforms[platformKey].enabled
  try {
    await api.updateConfig(daemonConfig.value)
    await refresh()
  } catch (e) {
    console.error('更新失败:', e)
  }
}

async function removePlatform(platformKey) {
  const agent = daemonConfig.value?.agents?.[0]
  if (!agent?.platforms?.[platformKey]) return
  delete agent.platforms[platformKey]
  try {
    await api.updateConfig(daemonConfig.value)
    await refresh()
  } catch (e) {
    console.error('移除失败:', e)
  }
}

// ── 测试 ──

function openTestDialog(teamName, platform) {
  testTarget.value = { team_name: teamName, platform }
  testForm.value = { chat_id: '', content: '测试消息' }
  showTestDialog.value = true
}

async function handleTest() {
  try {
    await api.testAgent(testTarget.value.team_name, {
      content: testForm.value.content,
      platform: testTarget.value.platform,
      chat_id: testForm.value.chat_id,
    })
    showTestDialog.value = false
  } catch (e) {
    console.error('测试失败:', e)
  }
}

// ── 主动推送 ──

async function handlePush() {
  pushSending.value = true
  try {
    await api.sendDaemonMessage(pushForm.value)
    pushForm.value.content = ''
  } catch (e) {
    console.error('推送失败:', e)
  } finally {
    pushSending.value = false
  }
}

// ── Cron 任务 ──

async function handleAddTask() {
  try {
    const payload = { ...newTask.value, task_id: 'cron_' + Date.now() }
    await api.createCronTask(payload)
    showAddTask.value = false
    newTask.value = {
      name: '', cron: '', task: '', team_name: 'default', entry_agent: '',
      push_platform: null, push_chat_id: '',
    }
    await refresh()
  } catch (e) {
    console.error('创建任务失败:', e)
  }
}

async function handleTriggerTask(taskId) {
  try { await api.triggerCronTask(taskId); await refresh() }
  catch (e) { console.error('触发失败:', e) }
}

async function handleToggleTask(task) {
  try { await api.updateCronTask(task.task_id, { enabled: !task.enabled }); await refresh() }
  catch (e) { console.error('更新失败:', e) }
}

async function handleDeleteTask(taskId) {
  try { await api.deleteCronTask(taskId); await refresh() }
  catch (e) { console.error('删除失败:', e) }
}

onMounted(refresh)
</script>
<style scoped>
.daemon-content { max-width: 900px; margin: 0 auto; }

/* ── Sections ── */
.section { margin-bottom: var(--spacing-lg); }
.section-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: var(--spacing-md);
}
.section-head h2 {
  font-size: 16px; font-weight: 600; color: var(--color-text-primary); margin: 0;
}
.header-actions { display: flex; gap: var(--spacing-sm); }

/* ── Buttons ── */
.pl-btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: var(--spacing-xs); height: 44px; min-height: 44px; padding: 0 16px;
  border-radius: 22px; border: 1px solid var(--color-border);
  background: var(--color-interactive); color: var(--color-text-primary);
  font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.2s;
}
.pl-btn:hover { background: var(--color-interactive-hover); }
.pl-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.pl-btn--primary { background: var(--color-brand-accent); color: #fff; border-color: transparent; }
.pl-btn--primary:hover { opacity: 0.85; background: var(--color-brand-accent); }
.pl-btn--danger { background: rgba(var(--color-error-rgb), 0.12); color: var(--color-error); border-color: rgba(var(--color-error-rgb), 0.3); }
.pl-btn--danger:hover { background: rgba(var(--color-error-rgb), 0.2); }
.pl-btn--ghost { background: transparent; color: var(--color-text-secondary); border-color: transparent; }
.pl-btn--ghost:hover { color: var(--color-text-primary); background: var(--color-bg-secondary); }

.act-btn {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 6px 11px; border-radius: var(--radius-sm); border: 1px solid var(--color-border);
  background: transparent; color: var(--color-text-secondary);
  font-size: var(--font-size-xs); font-weight: 500; cursor: pointer; transition: all 0.2s;
}
.act-btn:hover { color: var(--color-text-primary); background: var(--color-interactive); border-color: var(--color-border-hover); }
.act-btn--accent {
  border-color: rgba(var(--color-brand-accent-rgb), 0.4);
  background: rgba(var(--color-brand-accent-rgb), 0.12);
  color: var(--color-brand-accent-light); font-weight: 600;
}
.act-btn--accent:hover { background: rgba(var(--color-brand-accent-rgb), 0.2); border-color: rgba(var(--color-brand-accent-rgb), 0.5); color: var(--color-brand-accent); }
.act-btn--danger { color: var(--color-error); border-color: rgba(var(--color-error-rgb), 0.3); }
.act-btn--danger:hover { background: rgba(var(--color-error-rgb), 0.1); }

/* ── Badges ── */
.badge { display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-full); padding: 3px 9px; font-size: 11px; font-weight: 500; }
.badge-success { background: rgba(var(--color-success-rgb), 0.12); color: var(--color-success); }
.badge-warning { background: rgba(var(--color-warning-rgb), 0.12); color: var(--color-warning); }
.badge-neutral { background: var(--color-hover-overlay); color: var(--color-text-secondary); }

/* ── Stats Grid ── */
.stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--spacing-md); }
.stat-card {
  display: flex; flex-direction: column; align-items: center;
  padding: 20px; border-radius: 18px; background: var(--color-bg-secondary);
  border: 1px solid var(--color-border); gap: 4px;
}
.stat-value { font-size: 28px; font-weight: 700; color: var(--color-brand-accent); }
.stat-label { font-size: var(--font-size-xs); color: var(--color-text-secondary); }

/* ── Base Config ── */
.base-config-card {
  border-radius: var(--radius-xl);
  padding: var(--spacing-lg);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}
.switch-row {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
}
.section-tip {
  margin: var(--spacing-md) 0 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

/* ── Platform Config Cards ── */
.platform-config-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--spacing-md); }
.platform-config-card {
  border-radius: var(--radius-xl); padding: var(--spacing-lg);
  border: 1px solid var(--color-border); background: var(--color-bg-secondary);
  display: flex; flex-direction: column; gap: var(--spacing-md);
  transition: border-color 0.2s;
}
.platform-config-card:hover { border-color: var(--color-border-hover); }
.platform-config-card--active { border-color: rgba(var(--color-success-rgb), 0.35); }
.platform-config-head { display: flex; align-items: center; justify-content: space-between; }
.platform-config-name { font-size: 15px; font-weight: 600; color: var(--color-text-primary); }
.platform-config-body { display: flex; flex-direction: column; gap: 6px; }
.platform-config-field { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.platform-config-label { font-size: var(--font-size-xs); color: var(--color-text-muted); flex-shrink: 0; }
.platform-config-value {
  font-size: var(--font-size-xs); color: var(--color-text-secondary);
  font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.platform-config-actions { display: flex; gap: var(--spacing-sm); }

/* ── Toggle ── */
.platform-config-toggle { cursor: pointer; }
.toggle-track {
  width: 36px; height: 20px; border-radius: var(--radius-full);
  background: var(--color-bg-secondary); border: 1px solid var(--color-border);
  position: relative; transition: all 0.2s;
}
.toggle-track--on { background: rgba(var(--color-success-rgb), 0.25); border-color: rgba(var(--color-success-rgb), 0.5); }
.toggle-thumb {
  width: 14px; height: 14px; border-radius: 50%; background: var(--color-text-secondary);
  position: absolute; top: 2px; left: 2px; transition: all 0.2s;
}
.toggle-track--on .toggle-thumb { transform: translateX(16px); background: var(--color-success); }

/* ── Adapter Cards ── */
.adapter-grid { display: flex; flex-direction: column; gap: var(--spacing-md); }
.adapter-group-title { font-size: 14px; font-weight: 600; color: var(--color-text-primary); margin-bottom: var(--spacing-sm); }
.adapter-cards { display: flex; gap: var(--spacing-md); flex-wrap: wrap; }
.adapter-card {
  border-radius: var(--radius-xl); padding: var(--spacing-lg);
  min-width: 160px; display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--color-border); background: var(--color-bg-secondary);
  transition: border-color 0.2s;
}
.adapter-card:hover { border-color: var(--color-border-hover); }
.adapter-card--connected { border-color: rgba(var(--color-success-rgb), 0.3); }
.adapter-card--error { border-color: rgba(var(--color-error-rgb), 0.3); }
.adapter-platform { font-size: 14px; font-weight: 500; color: var(--color-text-primary); }
.adapter-status { font-size: var(--font-size-xs); color: var(--color-text-secondary); display: flex; align-items: center; gap: 6px; }

.dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.dot-connected { background: var(--color-success); }
.dot-disconnected { background: var(--color-text-secondary); }
.dot-connecting { background: var(--color-warning); }
.dot-error { background: var(--color-error); }

/* ── Cron Table ── */
.cron-table-wrap { overflow-x: auto; }
.cron-table { width: 100%; border-collapse: collapse; font-size: var(--font-size-sm); }
.cron-table th, .cron-table td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--color-border); }
.cron-table th { color: var(--color-text-muted); font-weight: 500; font-size: var(--font-size-xs); text-transform: uppercase; letter-spacing: 0.5px; }
.task-name { font-weight: 500; color: var(--color-text-primary); }
.task-desc { font-size: var(--font-size-xs); color: var(--color-text-muted); margin-top: 2px; }
.cron-expr {
  background: rgba(var(--color-brand-accent-rgb), 0.1); padding: 2px 8px;
  border-radius: var(--radius-sm); font-size: var(--font-size-xs);
  color: var(--color-brand-accent); font-family: var(--font-mono);
}
.task-actions { display: flex; gap: 4px; }

/* ── Push Form ── */
.push-form { display: flex; flex-direction: column; gap: var(--spacing-md); }

/* ── Form Controls ── */
.form-control {
  width: 100%; min-height: 44px; border-radius: 14px;
  border: 1px solid var(--color-border); background: var(--color-bg-secondary);
  color: var(--color-text-primary); padding: 0 14px; font-size: var(--font-size-sm);
  outline: none; transition: border-color 0.18s, box-shadow 0.18s;
}
.form-control:focus { border-color: rgba(var(--color-brand-accent-rgb), 0.52); box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.12); }
textarea.form-control { padding: 12px 14px; resize: vertical; min-height: 80px; font-family: inherit; }
select.form-control { cursor: pointer; }

.form-grid { display: grid; gap: var(--spacing-md); }
.form-grid.two-col { grid-template-columns: 1fr 1fr; }
.form-item { display: flex; flex-direction: column; gap: 6px; }
.form-label { font-size: var(--font-size-xs); font-weight: 500; color: var(--color-text-secondary); }

/* ── Modal ── */
.modal-backdrop {
  position: fixed; inset: 0; z-index: 100; background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center;
}
.modal-shell {
  width: min(480px, 100%); border-radius: var(--radius-xl);
  background: var(--glass-bg); backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--color-border); max-height: 80vh; overflow-y: auto;
}
.modal-shell--narrow { width: min(480px, 100%); }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: var(--spacing-lg) var(--spacing-lg) 0; }
.modal-header h3 { font-size: 16px; font-weight: 600; color: var(--color-text-primary); margin: 0; }
.modal-close {
  width: 32px; height: 32px; border-radius: var(--radius-md); border: none;
  background: transparent; color: var(--color-text-secondary); cursor: pointer;
  display: flex; align-items: center; justify-content: center; font-size: 14px; transition: all 0.2s;
}
.modal-close:hover { background: var(--color-interactive); color: var(--color-text-primary); }
.modal-body { padding: var(--spacing-lg); display: flex; flex-direction: column; gap: var(--spacing-md); }
.modal-footer {
  display: flex; justify-content: flex-end; gap: var(--spacing-sm);
  padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg); border-top: 1px solid var(--color-border);
}

/* ── State Panel ── */
.state-panel {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 16px; padding: 40px 20px; border-radius: var(--radius-lg);
  text-align: center; color: var(--color-text-secondary); font-size: var(--font-size-sm);
}

/* ── Responsive ── */
@media (max-width: 640px) {
  .stats-grid { grid-template-columns: 1fr; }
  .form-grid.two-col { grid-template-columns: 1fr; }
  .adapter-cards { flex-direction: column; }
  .platform-config-grid { grid-template-columns: 1fr; }
}
</style>
