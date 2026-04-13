<template>
  <PageLayout title="守护 Agent" subtitle="常驻守护系统 — 飞书消息网关 · 定时调度 · 心跳监控">
    <template #header-actions>
      <div class="hdr-actions">
        <button
          class="pl-btn" :class="status.running ? 'pl-btn--danger' : 'pl-btn--primary'"
          @click="toggleDaemon" :disabled="loading"
        >
          <svg v-if="!loading && status.running" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
          </svg>
          <svg v-else-if="!loading" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <span v-if="loading" class="btn-spin"/>
          {{ loading ? '...' : (status.running ? '停止' : '启动') }}
        </button>
        <button class="pl-btn pl-btn--ghost pl-btn--icon" @click="refresh" :disabled="loading" title="刷新">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </button>
      </div>
    </template>

    <div class="dmgr">

      <!-- 状态概览 -->
      <section class="dmgr-section">
        <div class="dmgr-section-head">
          <span class="dmgr-section-title">状态概览</span>
          <span class="status-badge" :class="statusBadgeClass">{{ statusBadgeText }}</span>
        </div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon stat-icon--blue">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
              </svg>
            </div>
            <div class="stat-body">
              <div class="stat-value">{{ status.adapter_count || 0 }}</div>
              <div class="stat-label">已连接平台</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon stat-icon--green">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
            </div>
            <div class="stat-body">
              <div class="stat-value">{{ cronTaskCount }}</div>
              <div class="stat-label">定时任务</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon stat-icon--purple">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <div class="stat-body">
              <div class="stat-value">{{ status.daemon_sessions || 0 }}</div>
              <div class="stat-label">守护会话</div>
            </div>
          </div>
        </div>
      </section>

      <!-- 基础配置 -->
      <section class="dmgr-section">
        <div class="dmgr-section-head">
          <span class="dmgr-section-title">基础配置</span>
          <button class="act-btn act-btn--accent" @click="saveBaseConfig" :disabled="baseSaving">
            {{ baseSaving ? '保存中...' : '保存' }}
          </button>
        </div>
        <div class="config-card">
          <div class="config-grid">
            <div class="form-item">
              <label class="form-label">守护系统开关</label>
              <div class="toggle-row">
                <span class="status-badge" :class="baseForm.enabled ? 'status-badge--success' : 'status-badge--neutral'">
                  {{ baseForm.enabled ? '已启用' : '未启用' }}
                </span>
                <button
                  class="toggle-btn" :class="{ 'toggle-btn--on': baseForm.enabled }"
                  @click="baseForm.enabled = !baseForm.enabled"
                  role="switch" :aria-checked="baseForm.enabled"
                ><span class="toggle-thumb"/></button>
              </div>
            </div>
            <div class="form-item">
              <label class="form-label">默认会话 TTL（秒）</label>
              <input v-model.number="baseForm.default_session_ttl" type="number" min="60" class="form-ctrl" />
            </div>
            <div class="form-item">
              <label class="form-label">Team 名称</label>
              <CustomSelect v-model="baseForm.team_name" :options="teamOptions" placeholder="default" />
            </div>
            <div class="form-item">
              <label class="form-label">入口 Agent</label>
              <CustomSelect v-model="baseForm.entry_agent" :options="agentOptions" placeholder="留空则用 team 的 default_entry" />
            </div>
            <div class="form-item">
              <label class="form-label">心跳间隔（秒）</label>
              <input v-model.number="baseForm.heartbeat_interval" type="number" min="5" class="form-ctrl" />
            </div>
            <div class="form-item">
              <label class="form-label">Agent 级 Session ID（可选）</label>
              <input v-model="baseForm.agent_session_id" class="form-ctrl" placeholder="留空则按 team_name + chat_id 自动派生" />
              <span class="section-tip">相同 ID 将复用历史上下文</span>
            </div>
          </div>
          <p class="section-tip">保存后若守护系统正在运行，会自动重载并应用新配置。</p>
        </div>
      </section>

      <!-- 平台配置 -->
      <section class="dmgr-section">
        <div class="dmgr-section-head">
          <span class="dmgr-section-title">平台配置</span>
          <button class="act-btn act-btn--accent" @click="openAddPlatform">+ 添加</button>
        </div>
        <div v-if="platformConfigs.length" class="platform-grid">
          <div
            v-for="pc in platformConfigs" :key="pc.key"
            class="platform-card" :class="{ 'platform-card--active': pc.enabled }"
          >
            <div class="platform-card-head">
              <div class="platform-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
                </svg>
              </div>
              <span class="platform-name">{{ platformLabel(pc.key) }}</span>
              <button
                class="toggle-btn toggle-btn--sm" :class="{ 'toggle-btn--on': pc.enabled }"
                @click="togglePlatformEnabled(pc.key)"
                role="switch" :aria-checked="pc.enabled"
              ><span class="toggle-thumb"/></button>
            </div>
            <div class="platform-fields">
              <div class="platform-field">
                <span class="pf-lbl">App ID</span>
                <span class="pf-val mono">{{ mask(pc.app_id) || '—' }}</span>
              </div>
              <div class="platform-field">
                <span class="pf-lbl">App Secret</span>
                <span class="pf-val mono">{{ mask(pc.app_secret) || '—' }}</span>
              </div>
              <div v-for="ef in pc.extra_fields" :key="ef.key" class="platform-field">
                <span class="pf-lbl">{{ ef.label }}</span>
                <span class="pf-val">{{ ef.value || '—' }}</span>
              </div>
            </div>
            <div class="platform-card-foot">
              <button class="act-btn" @click="openEditPlatform(pc.key)">编辑</button>
              <button class="act-btn act-btn--danger" @click="removePlatform(pc.key)">移除</button>
            </div>
          </div>
        </div>
        <div v-else class="empty-panel">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.35">
            <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <p>暂无平台配置，点击「添加」开始</p>
        </div>
      </section>

      <!-- 适配器状态 -->
      <section class="dmgr-section">
        <div class="dmgr-section-head">
          <span class="dmgr-section-title">适配器状态</span>
        </div>
        <div v-if="agents.length">
          <div v-for="agent in agents" :key="agent.team_name" class="adapter-group">
            <div class="adapter-group-lbl">{{ agent.team_name }}</div>
            <div class="adapter-row">
              <div
                v-for="(info, platform) in agent.platforms" :key="platform"
                class="adapter-chip"
                :class="{
                  'adapter-chip--connected': info.status === 'connected',
                  'adapter-chip--error': info.status === 'error',
                  'adapter-chip--connecting': info.status === 'connecting',
                }"
              >
                <span class="adp-dot"/>
                <span class="adp-name">{{ platformLabel(platform) }}</span>
                <span class="adp-status">{{ statusLabel(info.status) }}</span>
                <button
                  v-if="info.enabled && info.status === 'connected'"
                  class="act-btn act-btn--xs"
                  @click="openTestDialog(agent.team_name, platform)"
                >测试</button>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="empty-panel">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.35">
            <path d="M18 20V10M12 20V4M6 20v-6"/>
          </svg>
          <p>守护系统未运行或无已连接适配器</p>
        </div>
      </section>

      <!-- 权限配置 -->
      <section class="dmgr-section">
        <div class="dmgr-section-head">
          <span class="dmgr-section-title">权限配置</span>
          <button class="act-btn act-btn--accent" @click="savePermissions" :disabled="permSaving">
            {{ permSaving ? '保存中...' : '保存' }}
          </button>
        </div>
        <div class="config-card">
          <div class="config-grid">
            <div class="form-item">
              <label class="form-label">审批模式</label>
              <CustomSelect v-model="permForm.mode" :options="PERM_MODE_OPTIONS" :disabled="isSkipAllApprovals" />
              <p class="section-tip">strict: 所有风险工具须审批 | standard: medium+high | relaxed: 仅 high | dangerously_skip_permissions: 跳过常规风险审批</p>
            </div>
            <div class="form-item">
              <label class="form-label">审批超时（秒）</label>
              <input v-model.number="permForm.approval_timeout" type="number" min="1" class="form-ctrl" />
              <p class="section-tip">仅控制 daemon 桥接审批消息的等待时长；超时后自动拒绝。</p>
            </div>
          </div>
          <div class="toggle-row permission-toggle-row">
            <button class="toggle-btn toggle-btn--sm" :class="{ 'toggle-btn--on': permForm.skip_all_approvals }" @click="toggleSkipAllApprovals">
              <span class="toggle-thumb"></span>
            </button>
            <span>跳过所有审批</span>
          </div>
          <p class="section-tip">开启后跳过所有 ask 流程，但仍保留工具执行权限 deny。</p>

          <div class="permission-rule-head">
            <label class="form-label">自动接受规则</label>
            <span class="permission-rule-count">{{ autoAcceptPatternCount }} 条</span>
          </div>
          <div class="permission-rule-form">
            <CustomSelect v-model="newPatternForm.pattern_type" :options="autoAcceptPatternOptions" />
            <input v-model="newPatternForm.pattern_value" class="form-ctrl" placeholder="如: read_file / *.md / high" />
            <input v-model="newPatternForm.description" class="form-ctrl" placeholder="描述（可选）" />
            <button class="act-btn act-btn--accent" @click="addAutoAcceptPattern" :disabled="!newPatternForm.pattern_value.trim()">添加</button>
          </div>
          <div v-if="permForm.auto_accept_patterns.length" class="permission-rule-list">
            <div v-for="(pattern, index) in permForm.auto_accept_patterns" :key="`${pattern.pattern_type}-${pattern.pattern_value}-${index}`" class="permission-rule-item">
              <div class="permission-rule-main">
                <span class="permission-rule-type">{{ patternTypeLabel(pattern.pattern_type) }}</span>
                <code class="permission-rule-value">{{ pattern.pattern_value }}</code>
                <span v-if="pattern.description" class="permission-rule-desc">{{ pattern.description }}</span>
              </div>
              <button class="act-btn act-btn--icon act-btn--danger" @click="removeAutoAcceptPattern(index)" title="删除规则">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
          <div v-else class="empty-panel empty-panel--compact">
            <p>暂无自动接受规则</p>
          </div>
        </div>
      </section>

      <!-- 定时任务 -->
      <section class="dmgr-section">
        <div class="dmgr-section-head">
          <span class="dmgr-section-title">定时任务</span>
          <button class="act-btn act-btn--accent" @click="showAddTask = true">+ 新增</button>
        </div>
        <div v-if="cronTasks.length" class="cron-list">
          <div v-for="task in cronTasks" :key="task.task_id" class="cron-row">
            <div class="cron-row-main">
              <div class="cron-meta">
                <span class="cron-name">{{ task.name || task.task_id }}</span>
                <code class="cron-expr">{{ task.cron }}</code>
                <span class="status-badge" :class="task.enabled ? 'status-badge--success' : 'status-badge--neutral'">
                  {{ task.enabled ? '启用' : '禁用' }}
                </span>
              </div>
              <div class="cron-desc">{{ taskDesc(task.task) }}</div>
              <div class="cron-footer">
                <span class="cron-team">{{ task.team_name }}</span>
                <span v-if="task.push_platform" class="cron-push">→ {{ platformLabel(task.push_platform) }}</span>
                <span v-if="task.last_run" class="cron-time">上次: {{ formatTime(task.last_run) }}</span>
              </div>
            </div>
            <div class="cron-row-actions">
              <button class="act-btn act-btn--icon" @click="handleTriggerTask(task.task_id)" title="手动触发">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </button>
              <button class="act-btn act-btn--icon" @click="handleToggleTask(task)" :title="task.enabled ? '禁用' : '启用'">
                <svg v-if="task.enabled" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              </button>
              <button class="act-btn act-btn--icon act-btn--danger" @click="handleDeleteTask(task.task_id)" title="删除">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </div>
        </div>
        <div v-else class="empty-panel">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.35">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          <p>暂无定时任务</p>
        </div>
      </section>

      <!-- 主动推送 -->
      <section class="dmgr-section">
        <div class="dmgr-section-head">
          <span class="dmgr-section-title">主动推送</span>
        </div>
        <div class="config-card">
          <div class="push-row">
            <div class="push-platform-select">
              <CustomSelect v-model="pushForm.platform" :options="PLATFORM_OPTIONS" />
            </div>
            <input v-model="pushForm.chat_id" class="form-ctrl" placeholder="目标 chat_id" />
          </div>
          <textarea v-model="pushForm.content" class="form-ctrl" placeholder="推送内容" rows="2"/>
          <div class="push-foot">
            <button class="pl-btn pl-btn--primary" @click="handlePush" :disabled="pushSending || !pushForm.chat_id || !pushForm.content">
              {{ pushSending ? '发送中...' : '发送' }}
            </button>
          </div>
        </div>
      </section>

    </div>

    <!-- 平台配置弹窗 -->
    <teleport to="body">
      <div v-if="showConfigModal" class="modal-bg" @click.self="showConfigModal = false">
        <div class="modal-box">
          <div class="modal-hdr">
            <h3>{{ isNewPlatform ? '添加平台' : '编辑配置' }} — {{ platformLabel(platformForm.key) }}</h3>
            <button class="modal-close" @click="showConfigModal = false">×</button>
          </div>
          <div class="modal-body">
            <div v-if="isNewPlatform" class="form-item">
              <label class="form-label">平台</label>
              <CustomSelect v-model="platformForm.key" :options="PLATFORM_OPTIONS" />
            </div>
            <div class="form-two-col">
              <div class="form-item">
                <label class="form-label">App ID</label>
                <input v-model="platformForm.app_id" class="form-ctrl" placeholder="cli_xxxxxxxxxxxx" />
              </div>
              <div class="form-item">
                <label class="form-label">App Secret</label>
                <input v-model="platformForm.app_secret" class="form-ctrl" type="password" placeholder="粘贴你的应用密钥" />
              </div>
            </div>
            <div class="form-item">
              <label class="form-label">接收方式</label>
              <CustomSelect v-model="platformForm.receive_mode" :options="RECEIVE_MODE_OPTIONS" />
              <p class="section-tip">长连接无需公网地址；Webhook 需配置公网 HTTPS 回调。</p>
            </div>
            <div class="form-two-col">
              <div class="form-item">
                <label class="form-label">事件订阅 Token</label>
                <input v-model="platformForm.token" class="form-ctrl" placeholder="飞书事件订阅 Token" />
              </div>
              <div class="form-item">
                <label class="form-label">Encrypt Key（可选）</label>
                <input v-model="platformForm.encoding_aes_key" class="form-ctrl" placeholder="未开启消息加密可留空" />
              </div>
            </div>
            <div class="form-two-col">
              <div class="form-item">
                <label class="form-label">Webhook URL（可选）</label>
                <input v-model="platformForm.webhook_url" class="form-ctrl" placeholder="入站 Webhook 回调地址" />
              </div>
              <div class="form-item">
                <label class="form-label">平台级 Session ID（可选）</label>
                <input v-model="platformForm.session_id" class="form-ctrl" placeholder="留空则使用 agent 级配置" />
              </div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="pl-btn pl-btn--ghost" @click="showConfigModal = false">取消</button>
            <button class="pl-btn pl-btn--primary" @click="savePlatformConfig" :disabled="configSaving">
              {{ configSaving ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </teleport>

    <!-- 新增 Cron 任务弹窗 -->
    <teleport to="body">
      <div v-if="showAddTask" class="modal-bg" @click.self="showAddTask = false">
        <div class="modal-box">
          <div class="modal-hdr">
            <h3>新增定时任务</h3>
            <button class="modal-close" @click="showAddTask = false">×</button>
          </div>
          <div class="modal-body">
            <div class="form-two-col">
              <div class="form-item">
                <label class="form-label">任务名称</label>
                <input v-model="newTask.name" class="form-ctrl" placeholder="如：早间简报" />
              </div>
              <div class="form-item">
                <label class="form-label">Cron 表达式</label>
                <input v-model="newTask.cron" class="form-ctrl" placeholder="0 9 * * 1-5" />
                <p class="section-tip">分 时 日 月 周，如 <code>0 9 * * 1-5</code> = 工作日早 9 点</p>
              </div>
            </div>
            <div class="form-item">
              <label class="form-label">任务描述（传给 Agent）</label>
              <textarea v-model="newTask.task" class="form-ctrl" placeholder="请生成今日简报..." rows="2"/>
            </div>
            <div class="form-two-col">
              <div class="form-item">
                <label class="form-label">Team</label>
                <CustomSelect v-model="newTask.team_name" :options="teamOptions" placeholder="default" />
              </div>
              <div class="form-item">
                <label class="form-label">入口 Agent（可选）</label>
                <CustomSelect v-model="newTask.entry_agent" :options="agentOptions" placeholder="留空用 team 默认" />
              </div>
            </div>
            <div class="form-two-col">
              <div class="form-item">
                <label class="form-label">推送平台</label>
                <CustomSelect v-model="newTask.push_platform" :options="PLATFORM_OPTIONS_WITH_NONE" placeholder="不推送" />
              </div>
              <div class="form-item">
                <label class="form-label">推送 chat_id</label>
                <input v-model="newTask.push_chat_id" class="form-ctrl" placeholder="可选" />
              </div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="pl-btn pl-btn--ghost" @click="showAddTask = false">取消</button>
            <button class="pl-btn pl-btn--primary" @click="handleAddTask">创建</button>
          </div>
        </div>
      </div>
    </teleport>

    <!-- 测试消息弹窗 -->
    <teleport to="body">
      <div v-if="showTestDialog" class="modal-bg" @click.self="showTestDialog = false">
        <div class="modal-box modal-box--sm">
          <div class="modal-hdr">
            <h3>测试 — {{ platformLabel(testTarget.platform) }}</h3>
            <button class="modal-close" @click="showTestDialog = false">×</button>
          </div>
          <div class="modal-body">
            <div class="form-item">
              <label class="form-label">Chat ID</label>
              <input v-model="testForm.chat_id" class="form-ctrl" placeholder="真实 chat_id" />
            </div>
            <div class="form-item">
              <label class="form-label">消息内容</label>
              <input v-model="testForm.content" class="form-ctrl" placeholder="测试消息" />
            </div>
          </div>
          <div class="modal-foot">
            <button class="pl-btn pl-btn--ghost" @click="showTestDialog = false">取消</button>
            <button class="pl-btn pl-btn--primary" @click="handleTest">发送</button>
          </div>
        </div>
      </div>
    </teleport>

  </PageLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import PageLayout from '../components/PageLayout.vue'
import CustomSelect from '../components/CustomSelect.vue'
import * as api from '../api/daemon'
import { getTeams, getAllAgentConfigs } from '../api/agentConfig'
import {
  AUTO_ACCEPT_PATTERN_OPTIONS,
  createEmptyAutoAcceptPattern,
  normalizePermissionPolicy,
  serializePermissionPolicy,
} from '../utils/permissionPresentation'

const teamOptions = ref([])
const agentOptions = ref([])

const PLATFORM_OPTIONS = [
  { value: 'feishu', label: '飞书' },
  { value: 'dingtalk', label: '钉钉' },
  { value: 'wechat', label: '企业微信' },
]

const PLATFORM_OPTIONS_WITH_NONE = [
  { value: '', label: '不推送' },
  ...PLATFORM_OPTIONS,
]

const RECEIVE_MODE_OPTIONS = [
  { value: 'long_connection', label: '长连接（推荐，无需公网）' },
  { value: 'webhook', label: 'Webhook（需要公网 HTTPS）' },
]

const PERM_MODE_OPTIONS = [
  { value: 'strict', label: 'strict（所有风险工具须审批）' },
  { value: 'standard', label: 'standard（medium+high 须审批）' },
  { value: 'relaxed', label: 'relaxed（仅 high 须审批）' },
  { value: 'dangerously_skip_permissions', label: 'dangerously_skip_permissions（跳过常规风险审批）' },
]

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
const permSaving = ref(false)
const isNewPlatform = ref(false)

const permForm = ref(normalizePermissionPolicy())
const newPatternForm = ref(createEmptyAutoAcceptPattern())

const baseForm = ref({
  enabled: false,
  default_session_ttl: 86400,
  agent_session_id: '',
  team_name: 'default',
  entry_agent: '',
  heartbeat_interval: 30,
})

const testTarget = ref({ team_name: '', platform: '' })
const testForm = ref({ chat_id: '', content: '测试消息' })
const pushForm = ref({ platform: 'feishu', chat_id: '', content: '' })
const pushSending = ref(false)

const newTask = ref({
  name: '', cron: '', task: '', team_name: 'default', entry_agent: '',
  push_platform: null, push_chat_id: '',
})

const platformForm = ref({
  key: 'feishu',
  app_id: '', app_secret: '', token: '', encoding_aes_key: '',
  webhook_url: '', session_id: '',
  receive_mode: 'long_connection',
})

// ── 计算属性 ──

const statusBadgeClass = computed(() => {
  if (status.value.running) return 'status-badge--success'
  if (status.value.enabled) return 'status-badge--warning'
  return 'status-badge--neutral'
})

const statusBadgeText = computed(() => {
  if (status.value.running) return '运行中'
  if (status.value.enabled) return '已配置'
  return '未启用'
})

const cronTaskCount = computed(() => cronTasks.value.length)
const autoAcceptPatternOptions = AUTO_ACCEPT_PATTERN_OPTIONS
const autoAcceptPatternCount = computed(() => permForm.value.auto_accept_patterns.length)
const isSkipAllApprovals = computed(() => Boolean(permForm.value.skip_all_approvals))

const platformConfigs = computed(() => {
  const agent = daemonConfig.value?.agents?.[0]
  if (!agent) return []
  return Object.entries(agent.platforms || {}).map(([key, conn]) => {
    const extra = conn.extra || {}
    const extraFields = []
    if (key === 'feishu') {
      extraFields.push({ key: 'receive_mode', label: '接收方式', value: extra.receive_mode === 'long_connection' ? '长连接' : 'Webhook' })
    }
    return { key, enabled: conn.enabled, app_id: conn.app_id, app_secret: conn.app_secret, extra_fields: extraFields }
  })
})

// ── 工具函数 ──

function platformLabel(p) {
  return { feishu: '飞书' }[p] || p
}

function statusLabel(s) {
  return { connected: '已连接', disconnected: '未连接', connecting: '连接中', error: '异常' }[s] || s
}

function taskDesc(text) {
  if (!text) return ''
  return text.length > 80 ? text.slice(0, 80) + '...' : text
}

function mask(val) {
  if (!val) return ''
  if (val.length <= 8) return '****'
  return val.slice(0, 4) + '****' + val.slice(-4)
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function patternTypeLabel(type) {
  return autoAcceptPatternOptions.find(option => option.value === type)?.label || type
}

function addAutoAcceptPattern() {
  const pattern = {
    pattern_type: newPatternForm.value.pattern_type,
    pattern_value: String(newPatternForm.value.pattern_value || '').trim(),
    description: String(newPatternForm.value.description || '').trim(),
  }
  if (!pattern.pattern_value) return
  permForm.value.auto_accept_patterns = [
    ...permForm.value.auto_accept_patterns,
    pattern,
  ]
  newPatternForm.value = createEmptyAutoAcceptPattern()
}

function removeAutoAcceptPattern(index) {
  permForm.value.auto_accept_patterns = permForm.value.auto_accept_patterns.filter((_, i) => i !== index)
}

function toggleSkipAllApprovals() {
  permForm.value.skip_all_approvals = !permForm.value.skip_all_approvals
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
        agent_session_id: agent?.session_id || '',
        team_name: agent?.team_name || 'default',
        entry_agent: agent?.entry_agent || '',
        heartbeat_interval: agent?.heartbeat_interval || 30,
      }
      permForm.value = normalizePermissionPolicy(agent?.permissions || {})
      newPatternForm.value = createEmptyAutoAcceptPattern()
    }
  } catch (e) {
    console.error('刷新失败:', e)
  } finally {
    loading.value = false
  }
}

// ── 系统控制 ──

async function toggleDaemon() {
  loading.value = true
  try {
    status.value.running ? await api.stopDaemon() : await api.startDaemon()
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
    agent.session_id = baseForm.value.agent_session_id || null
    agent.heartbeat_interval = Math.max(5, Number(baseForm.value.heartbeat_interval) || 30)
    await api.updateConfig(daemonConfig.value)
    await refresh()
  } catch (e) {
    console.error('保存基础配置失败:', e)
  } finally {
    baseSaving.value = false
  }
}

// ── 权限配置 ──

async function savePermissions() {
  permSaving.value = true
  try {
    const agent = ensureAgentEntry()
    agent.permissions = serializePermissionPolicy(permForm.value)
    await api.updateConfig(daemonConfig.value)
    await refresh()
  } catch (e) {
    console.error('保存权限配置失败:', e)
  } finally {
    permSaving.value = false
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
  platformForm.value = { key: 'feishu', app_id: '', app_secret: '', token: '', encoding_aes_key: '', webhook_url: '', session_id: '', receive_mode: 'long_connection' }
  showConfigModal.value = true
}

function openEditPlatform(platformKey) {
  isNewPlatform.value = false
  const conn = daemonConfig.value?.agents?.[0]?.platforms?.[platformKey] || {}
  platformForm.value = {
    key: platformKey,
    app_id: conn.app_id || '',
    app_secret: conn.app_secret || '',
    token: conn.token || '',
    encoding_aes_key: conn.encoding_aes_key || '',
    webhook_url: conn.webhook_url || '',
    session_id: conn.session_id || '',
    receive_mode: conn.extra?.receive_mode || 'long_connection',
  }
  showConfigModal.value = true
}

async function savePlatformConfig() {
  configSaving.value = true
  try {
    const agent = ensureAgentEntry()
    const f = platformForm.value
    const extra = { ...agent.platforms[f.key]?.extra, receive_mode: f.receive_mode || 'long_connection' }
    agent.platforms[f.key] = {
      enabled: true,
      app_id: f.app_id || null,
      app_secret: f.app_secret || null,
      token: f.token || null,
      encoding_aes_key: f.encoding_aes_key || null,
      webhook_url: f.webhook_url || null,
      session_id: f.session_id || null,
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
  try { await api.updateConfig(daemonConfig.value); await refresh() }
  catch (e) { console.error('更新失败:', e) }
}

async function removePlatform(platformKey) {
  const agent = daemonConfig.value?.agents?.[0]
  if (!agent?.platforms?.[platformKey]) return
  delete agent.platforms[platformKey]
  try { await api.updateConfig(daemonConfig.value); await refresh() }
  catch (e) { console.error('移除失败:', e) }
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
  } catch (e) { console.error('测试失败:', e) }
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
    await api.createCronTask({ ...newTask.value, task_id: 'cron_' + Date.now() })
    showAddTask.value = false
    newTask.value = { name: '', cron: '', task: '', team_name: 'default', entry_agent: '', push_platform: null, push_chat_id: '' }
    await refresh()
  } catch (e) { console.error('创建任务失败:', e) }
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

async function loadTeamAgentOptions() {
  try {
    const [teamsData, agentsData] = await Promise.all([
      getTeams().catch(() => ({ teams: [] })),
      getAllAgentConfigs().catch(() => ({})),
    ])
    teamOptions.value = (teamsData.teams || []).map(t => ({
      value: t.team_name || t,
      label: t.team_name || t,
    }))
    agentOptions.value = Object.entries(agentsData || {}).map(([name, cfg]) => ({
      value: name,
      label: cfg?.display_name ? `${cfg.display_name} (${name})` : name,
    }))
  } catch (e) {
    console.error('加载 Team/Agent 列表失败', e)
  }
}

onMounted(() => { refresh(); loadTeamAgentOptions() })
</script>

<style scoped>
/* ── 顶部操作栏 ── */
.hdr-actions { display: flex; align-items: center; gap: 6px; }
.btn-spin {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff;
  animation: spin 0.6s linear infinite;
  display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── 页面容器 ── */
.dmgr { display: flex; flex-direction: column; gap: var(--spacing-lg); }

/* ── Section ── */
.dmgr-section {
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  padding: var(--spacing-lg);
  display: flex; flex-direction: column; gap: var(--spacing-md);
}
.dmgr-section-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm);
}
.dmgr-section-title {
  font-size: 13px; font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase; letter-spacing: 0.06em;
}
.section-tip {
  font-size: 11px; color: var(--color-text-muted);
  margin: 0; line-height: 1.5;
}
.section-tip code {
  font-family: var(--font-mono, monospace);
  background: rgba(var(--color-brand-accent-rgb), 0.12);
  color: var(--color-brand-accent-light);
  padding: 1px 5px; border-radius: 4px;
}

/* ── 状态徽章 ── */
.status-badge {
  display: inline-flex; align-items: center;
  padding: 2px 9px; border-radius: 999px;
  font-size: 11px; font-weight: 500; line-height: 1.6;
}
.status-badge--success { background: rgba(var(--color-success-rgb),.14); color: var(--color-success); }
.status-badge--warning { background: rgba(var(--color-warning-rgb),.14); color: var(--color-warning); }
.status-badge--neutral { background: var(--color-hover-overlay); color: var(--color-text-secondary); }

/* ── 按钮 ── */
.pl-btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 6px; height: 36px; min-height: 36px; padding: 0 14px;
  border-radius: 18px; border: 1px solid var(--color-border);
  background: var(--color-interactive); color: var(--color-text-primary);
  font-size: 12px; font-weight: 500; cursor: pointer;
  transition: background 0.18s, border-color 0.18s, opacity 0.18s;
  white-space: nowrap; flex-shrink: 0; user-select: none;
}
.pl-btn:hover:not(:disabled) { background: var(--color-interactive-hover); border-color: var(--color-border-hover); }
.pl-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.pl-btn--primary { background: var(--color-brand-accent); color: #fff; border-color: transparent; }
.pl-btn--primary:hover:not(:disabled) { opacity: 0.88; background: var(--color-brand-accent); }
.pl-btn--danger { background: rgba(var(--color-error-rgb),.12); color: var(--color-error); border-color: rgba(var(--color-error-rgb),.28); }
.pl-btn--danger:hover:not(:disabled) { background: rgba(var(--color-error-rgb),.2); }
.pl-btn--ghost { background: transparent; color: var(--color-text-secondary); border-color: transparent; }
.pl-btn--ghost:hover:not(:disabled) { background: var(--color-hover-overlay); color: var(--color-text-primary); }
.pl-btn--icon { width: 36px; min-width: 36px; padding: 0; }

.act-btn {
  display: inline-flex; align-items: center; justify-content: center;
  gap: 4px; padding: 5px 10px;
  border-radius: var(--radius-sm); border: 1px solid var(--color-border);
  background: transparent; color: var(--color-text-secondary);
  font-size: 11px; font-weight: 500; cursor: pointer;
  transition: all 0.18s; white-space: nowrap; flex-shrink: 0;
}
.act-btn:hover { color: var(--color-text-primary); background: var(--color-hover-overlay); border-color: var(--color-border-hover); }
.act-btn--accent {
  border-color: rgba(var(--color-brand-accent-rgb),.35);
  background: rgba(var(--color-brand-accent-rgb),.1);
  color: var(--color-brand-accent-light); font-weight: 600;
}
.act-btn--accent:hover { background: rgba(var(--color-brand-accent-rgb),.18); }
.act-btn--danger { color: var(--color-error); border-color: rgba(var(--color-error-rgb),.28); }
.act-btn--danger:hover { background: rgba(var(--color-error-rgb),.1); }
.act-btn--icon { width: 28px; height: 28px; padding: 0; }
.act-btn--xs { padding: 2px 8px; font-size: 10px; }

/* ── Toggle ── */
.toggle-row { display: flex; align-items: center; gap: var(--spacing-sm); min-height: 36px; }
.toggle-btn {
  width: 36px; height: 20px; border-radius: 10px; border: none; padding: 0;
  background: var(--color-bg-tertiary); cursor: pointer;
  position: relative; transition: background 0.2s;
  flex-shrink: 0;
}
.toggle-btn--on { background: var(--color-success); }
.toggle-btn--sm { width: 30px; height: 16px; border-radius: 8px; }
.toggle-thumb {
  position: absolute; top: 3px; left: 3px;
  width: 14px; height: 14px; border-radius: 50%;
  background: #fff; transition: transform 0.2s;
  display: block;
}
.toggle-btn--on .toggle-thumb { transform: translateX(16px); }
.toggle-btn--sm .toggle-thumb { width: 10px; height: 10px; top: 3px; left: 3px; }
.toggle-btn--sm.toggle-btn--on .toggle-thumb { transform: translateX(14px); }

/* ── 统计卡片 ── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--spacing-md);
}
.stat-card {
  display: flex; align-items: center; gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  border-radius: var(--radius-lg);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
}
.stat-icon {
  width: 38px; height: 38px; border-radius: var(--radius-md);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.stat-icon--blue { background: rgba(var(--color-brand-accent-rgb),.14); color: var(--color-brand-accent); }
.stat-icon--green { background: rgba(var(--color-success-rgb),.14); color: var(--color-success); }
.stat-icon--purple { background: rgba(168,85,247,.14); color: #c084fc; }
.stat-body { display: flex; flex-direction: column; gap: 2px; }
.stat-value { font-size: 22px; font-weight: 700; color: var(--color-text-primary); line-height: 1; }
.stat-label { font-size: 11px; color: var(--color-text-muted); }

/* ── 配置卡片 ── */
.config-card {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--spacing-md);
  display: flex; flex-direction: column; gap: var(--spacing-md);
}
.config-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--spacing-md);
}

/* ── 表单控件 ── */
.form-item { display: flex; flex-direction: column; gap: 5px; }
.form-label { font-size: 11px; font-weight: 500; color: var(--color-text-secondary); }
.form-ctrl {
  width: 100%; min-height: 36px; padding: 0 12px;
  border-radius: var(--radius-md); border: 1px solid var(--color-border);
  background: var(--color-bg-tertiary); color: var(--color-text-primary);
  font-size: 13px; outline: none; box-sizing: border-box;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.form-ctrl:focus { border-color: rgba(var(--color-brand-accent-rgb),.5); box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb),.1); }
textarea.form-ctrl { padding: 10px 12px; resize: vertical; min-height: 72px; font-family: inherit; }
select.form-ctrl { cursor: pointer; }
.form-ctrl--sm { min-width: 100px; flex-shrink: 0; }
.form-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--spacing-md); }

/* ── 权限配置 ── */
.permission-toggle-row { margin-top: 4px; }
.permission-rule-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm);
}
.permission-rule-count {
  font-size: 11px; color: var(--color-text-muted);
}
.permission-rule-form {
  display: grid; grid-template-columns: 160px minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: var(--spacing-sm); align-items: center;
}
.permission-rule-list {
  display: flex; flex-direction: column; gap: var(--spacing-sm);
}
.permission-rule-item {
  display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm);
  padding: 10px 12px; border-radius: var(--radius-md);
  border: 1px solid var(--color-border); background: var(--color-bg-tertiary);
}
.permission-rule-main {
  display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap;
}
.permission-rule-type {
  display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
  background: rgba(var(--color-brand-accent-rgb),.12); color: var(--color-brand-accent-light);
  font-size: 11px; font-weight: 500;
}
.permission-rule-value {
  font-family: var(--font-mono, monospace); font-size: 12px;
  color: var(--color-text-primary); word-break: break-all;
}
.permission-rule-desc {
  font-size: 11px; color: var(--color-text-muted);
}
.empty-panel--compact {
  padding: 16px 12px;
}

/* ── 平台卡片 ── */
.platform-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--spacing-md);
}
.platform-card {
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  padding: var(--spacing-md);
  display: flex; flex-direction: column; gap: var(--spacing-sm);
  transition: border-color 0.18s;
}
.platform-card:hover { border-color: var(--color-border-hover); }
.platform-card--active { border-color: rgba(var(--color-success-rgb),.3); }
.platform-card-head {
  display: flex; align-items: center; gap: var(--spacing-sm);
}
.platform-icon {
  width: 32px; height: 32px; border-radius: var(--radius-sm);
  background: rgba(var(--color-brand-accent-rgb),.12);
  display: flex; align-items: center; justify-content: center;
  color: var(--color-brand-accent); flex-shrink: 0;
}
.platform-name { font-size: 14px; font-weight: 600; color: var(--color-text-primary); flex: 1; }
.platform-fields { display: flex; flex-direction: column; gap: 4px; }
.platform-field { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.pf-lbl { font-size: 11px; color: var(--color-text-muted); flex-shrink: 0; }
.pf-val { font-size: 11px; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-val.mono { font-family: var(--font-mono, monospace); }
.platform-card-foot { display: flex; gap: var(--spacing-sm); padding-top: 4px; }

/* ── 适配器状态 ── */
.adapter-group { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.adapter-group-lbl { font-size: 12px; font-weight: 500; color: var(--color-text-muted); }
.adapter-row { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
.adapter-chip {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 14px; border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  font-size: 13px; transition: border-color 0.18s;
}
.adapter-chip--connected { border-color: rgba(var(--color-success-rgb),.3); }
.adapter-chip--error { border-color: rgba(var(--color-error-rgb),.3); }
.adapter-chip--connecting { border-color: rgba(var(--color-warning-rgb),.3); }
.adp-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  background: var(--color-text-muted);
}
.adapter-chip--connected .adp-dot { background: var(--color-success); }
.adapter-chip--error .adp-dot { background: var(--color-error); }
.adapter-chip--connecting .adp-dot { background: var(--color-warning); animation: pulse 1s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
.adp-name { font-weight: 500; color: var(--color-text-primary); }
.adp-status { font-size: 11px; color: var(--color-text-muted); }

/* ── Cron 列表 ── */
.cron-list {
  display: flex; flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.cron-row {
  display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md);
  padding: 12px var(--spacing-md);
  border-bottom: 1px solid var(--color-border);
  transition: background 0.15s;
}
.cron-row:last-child { border-bottom: none; }
.cron-row:hover { background: var(--color-hover-overlay); }
.cron-row-main { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.cron-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cron-name { font-size: 13px; font-weight: 500; color: var(--color-text-primary); }
.cron-expr {
  font-family: var(--font-mono, monospace); font-size: 11px;
  background: rgba(var(--color-brand-accent-rgb),.1);
  color: var(--color-brand-accent-light);
  padding: 2px 7px; border-radius: 5px;
}
.cron-desc { font-size: 12px; color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cron-footer { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cron-team { font-size: 11px; color: var(--color-text-muted); }
.cron-push { font-size: 11px; color: var(--color-brand-accent-light); }
.cron-time { font-size: 11px; color: var(--color-text-muted); }
.cron-row-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }

/* ── 推送表单 ── */
.push-row { display: flex; gap: var(--spacing-sm); align-items: flex-start; }
.push-platform-select { width: 130px; flex-shrink: 0; }
.push-foot { display: flex; justify-content: flex-end; }

/* ── 空状态 ── */
.empty-panel {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 36px 20px;
  color: var(--color-text-muted); font-size: 13px; text-align: center;
}
.empty-panel p { margin: 0; }

/* ── 弹窗 ── */
.modal-bg {
  position: fixed; inset: 0; z-index: 2000;
  background: rgba(0,0,0,.55); backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
  padding: var(--spacing-md);
}
.modal-box {
  width: min(480px, 100%); max-height: 88vh; overflow-y: auto;
  border-radius: var(--radius-xl);
  background: var(--glass-bg); backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--color-glass-border);
  box-shadow: var(--shadow-xl);
  display: flex; flex-direction: column;
}
.modal-box--sm { width: min(360px, 100%); }
.modal-hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--spacing-lg) var(--spacing-lg) 0;
  flex-shrink: 0;
}
.modal-hdr h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--color-text-primary); }
.modal-close {
  width: 28px; height: 28px; border-radius: var(--radius-sm); border: none;
  background: transparent; color: var(--color-text-secondary);
  font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center;
  transition: background 0.18s, color 0.18s; flex-shrink: 0;
}
.modal-close:hover { background: var(--color-hover-overlay); color: var(--color-text-primary); }
.modal-body {
  padding: var(--spacing-lg);
  display: flex; flex-direction: column; gap: var(--spacing-md);
  flex: 1; min-height: 0;
}
.modal-foot {
  display: flex; justify-content: flex-end; gap: var(--spacing-sm);
  padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  border-top: 1px solid var(--color-border); flex-shrink: 0;
}

/* CustomSelect 高度对齐 form-ctrl */
:deep(.select-trigger) {
  height: 36px;
  min-height: 36px;
  font-size: 13px;
  font-weight: 400;
}

/* ── 响应式 ── */
@media (max-width: 680px) {
  .stats-grid { grid-template-columns: 1fr 1fr; }
  .config-grid { grid-template-columns: 1fr; }
  .form-two-col { grid-template-columns: 1fr; }
  .platform-grid { grid-template-columns: 1fr; }
  .push-row { flex-direction: column; }
  .cron-row { flex-direction: column; align-items: flex-start; }
  .cron-row-actions { align-self: flex-end; }
  .permission-rule-form { grid-template-columns: 1fr; }
  .permission-rule-item { align-items: flex-start; }
}
@media (max-width: 400px) {
  .stats-grid { grid-template-columns: 1fr; }
  .stat-card { padding: var(--spacing-md); }
}
</style>
