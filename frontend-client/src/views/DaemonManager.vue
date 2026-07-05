<template>
  <PageLayout title="守护 Agent" subtitle="飞书网关 · 定时调度 · 心跳监控">
    <template #header-actions>
      <div class="hdr-actions">
        <Button size="sm" :variant="status.running ? 'destructive' : 'default'" :disabled="loading" @click="toggleDaemon">
            <IconPause v-if="!loading && status.running" :size="14" />
            <IconPlay v-else-if="!loading" :size="14" />
            <span v-if="loading" class="btn-spin"/>
            <span>{{ loading ? '...' : (status.running ? '停止' : '启动') }}</span>
        </Button>
        <Button variant="ghost" size="icon" aria-label="刷新" :disabled="loading" @click="refresh">
          <IconRefresh :size="16" />
        </Button>
      </div>
    </template>

    <template #mobile-menu="{ close }">
      <button class="pl-menu-item" :disabled="loading" @click="toggleDaemon(); close()">
        <IconPause v-if="!loading && status.running" :size="16" />
        <IconPlay v-else-if="!loading" :size="16" />
        <span v-else class="btn-spin"></span>
        {{ loading ? '处理中...' : (status.running ? '停止守护系统' : '启动守护系统') }}
      </button>
      <button class="pl-menu-item" :disabled="loading" @click="refresh(); close()">
        <IconRefresh :size="16" />
        刷新
      </button>
    </template>

    <div class="dmgr">
      <section class="dmgr-section adm-panel">
        <div class="dmgr-section-head">
          <span class="dmgr-section-title">状态概览</span>
          <UiBadge class="status-badge" size="sm" :tone="statusBadgeTone">{{ statusBadgeText }}</UiBadge>
        </div>
        <KpiCards :items="statusKpis" />
      </section>

      <section class="dmgr-section adm-panel">
        <div class="dmgr-section-head">
          <span class="dmgr-section-title">基础配置</span>
          <Button variant="default" size="sm" :disabled="baseSaving" @click="saveBaseConfig">{{ baseSaving ? '保存中...' : '保存' }}</Button>
        </div>
        <div class="config-card">
          <div class="config-grid">
            <div class="form-item">
              <label class="form-label">守护系统开关</label>
              <div class="toggle-row">
                <UiBadge class="status-badge" size="sm" :tone="baseForm.enabled ? 'success' : 'neutral'">{{ baseForm.enabled ? '已启用' : '未启用' }}</UiBadge>
                <ToggleSwitch v-model="baseForm.enabled" />
              </div>
            </div>
            <div class="form-item"><label class="form-label">默认会话 TTL（秒）</label><input v-model.number="baseForm.default_session_ttl" type="number" min="60" class="form-ctrl" /></div>
            <div class="form-item"><label class="form-label">Team 名称</label><CustomSelect v-model="baseForm.team_name" :options="teamOptions" placeholder="default" /></div>
            <div class="form-item"><label class="form-label">入口 Agent</label><CustomSelect v-model="baseForm.entry_agent" :options="agentOptions" placeholder="留空则用 team 的 default_entry" /></div>
            <div class="form-item"><label class="form-label">心跳间隔（秒）</label><input v-model.number="baseForm.heartbeat_interval" type="number" min="5" class="form-ctrl" /></div>
            <div class="form-item"><label class="form-label">Agent 级 Session ID（可选）</label><input v-model="baseForm.agent_session_id" class="form-ctrl" placeholder="留空则按 team_name + chat_id 自动派生" /><span class="section-tip">相同 ID 将复用历史上下文</span></div>
          </div>
          <p class="section-tip">保存后若守护系统正在运行，会自动重载并应用新配置。</p>
        </div>
      </section>

      <section class="dmgr-section adm-panel">
        <div class="dmgr-section-head">
          <span class="dmgr-section-title">平台配置</span>
          <Button variant="default" size="sm" @click="openAddPlatform">+ 添加</Button>
        </div>
        <div v-if="platformConfigs.length" class="platform-grid">
          <div v-for="pc in platformConfigs" :key="pc.key" class="platform-card" :class="{ 'platform-card--active': pc.enabled }">
            <div class="platform-card-head">
              <div class="platform-icon"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></div>
              <span class="platform-name">{{ platformLabel(pc.key) }}</span>
              <ToggleSwitch :model-value="pc.enabled" @update:model-value="togglePlatformEnabled(pc.key)" size="sm" />
            </div>
            <div class="platform-fields">
              <div class="platform-field"><span class="pf-lbl">App ID</span><span class="pf-val mono">{{ mask(pc.app_id) || '—' }}</span></div>
              <div class="platform-field"><span class="pf-lbl">App Secret</span><span class="pf-val mono">{{ mask(pc.app_secret) || '—' }}</span></div>
              <div v-for="ef in pc.extra_fields" :key="ef.key" class="platform-field"><span class="pf-lbl">{{ ef.label }}</span><span class="pf-val">{{ ef.value || '—' }}</span></div>
            </div>
            <div class="platform-card-foot">
              <Button variant="action-neutral" size="action" @click="openEditPlatform(pc.key)">编辑</Button>
              <Button variant="action-danger" size="action" @click="removePlatform(pc.key)">移除</Button>
            </div>
          </div>
        </div>
        <div v-else class="empty-panel adm-state adm-state--empty">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.35"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          <p>暂无平台配置，点击「添加」开始</p>
        </div>
      </section>

      <section class="dmgr-section adm-panel">
        <div class="dmgr-section-head"><span class="dmgr-section-title">适配器状态</span></div>
        <div v-if="agents.length">
          <div v-for="agent in agents" :key="agent.team_name" class="adapter-group">
            <div class="adapter-group-lbl">{{ agent.team_name }}</div>
            <div class="adapter-row">
              <div v-for="(info, platform) in agent.platforms" :key="platform" class="adapter-chip" :class="{ 'adapter-chip--connected': info.status === 'connected', 'adapter-chip--error': info.status === 'error', 'adapter-chip--connecting': info.status === 'connecting' }">
                <span class="adp-dot"/>
                <span class="adp-name">{{ platformLabel(platform) }}</span>
                <span class="adp-status">{{ statusLabel(info.status) }}</span>
                <Button v-if="info.enabled && info.status === 'connected'" variant="action-neutral" size="action" @click="openTestDialog(agent.team_name, platform)">测试</Button>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="empty-panel adm-state adm-state--empty">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.35"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
          <p>守护系统未运行或无已连接适配器</p>
        </div>
      </section>

      <section class="dmgr-section adm-panel">
        <div class="dmgr-section-head">
          <span class="dmgr-section-title">权限配置</span>
          <Button variant="default" size="sm" :disabled="permSaving" @click="savePermissions">{{ permSaving ? '保存中...' : '保存' }}</Button>
        </div>
        <div class="config-card">
          <div class="config-grid">
            <div class="form-item">
              <label class="form-label">审批模式</label>
              <CustomSelect v-model="permForm.mode" :options="PERM_MODE_OPTIONS" :disabled="isSkipAllApprovals" />
              <p class="section-tip">strict: 所有风险工具须审批 | standard: medium+high | relaxed: 仅 high | dangerously_skip_permissions: 跳过常规风险审批</p>
            </div>
            <div class="form-item"><label class="form-label">审批超时（秒）</label><input v-model.number="permForm.approval_timeout" type="number" min="1" class="form-ctrl" /><p class="section-tip">仅控制 daemon 桥接审批消息的等待时长；超时后自动拒绝。</p></div>
          </div>
          <div class="toggle-row permission-toggle-row">
            <ToggleSwitch :model-value="permForm.skip_all_approvals" @update:model-value="toggleSkipAllApprovals" size="sm" />
            <span>跳过所有审批</span>
          </div>
          <p class="section-tip">开启后跳过所有 ask 流程，但仍保留工具执行权限 deny。</p>
          <div class="permission-rule-head"><label class="form-label">自动接受规则</label><span class="permission-rule-count">{{ autoAcceptPatternCount }} 条</span></div>
          <div class="permission-rule-form">
            <CustomSelect v-model="newPatternForm.pattern_type" :options="autoAcceptPatternOptions" />
            <input v-model="newPatternForm.pattern_value" class="form-ctrl" placeholder="如: read_file / *.md / high" />
            <input v-model="newPatternForm.description" class="form-ctrl" placeholder="描述（可选）" />
            <Button variant="default" size="sm" :disabled="!newPatternForm.pattern_value.trim()" @click="addAutoAcceptPattern">添加</Button>
          </div>
          <div v-if="permForm.auto_accept_patterns.length" class="permission-rule-list">
            <div v-for="(pattern, index) in permForm.auto_accept_patterns" :key="`${pattern.pattern_type}-${pattern.pattern_value}-${index}`" class="permission-rule-item">
              <div class="permission-rule-main">
                <span class="permission-rule-type">{{ patternTypeLabel(pattern.pattern_type) }}</span>
                <code class="permission-rule-value">{{ pattern.pattern_value }}</code>
                <span v-if="pattern.description" class="permission-rule-desc">{{ pattern.description }}</span>
              </div>
              <Button variant="destructive" size="icon" aria-label="删除规则" @click="removeAutoAcceptPattern(index)"><IconClose :size="13" :stroke-width="2.5" /></Button>
            </div>
          </div>
          <div v-else class="empty-panel empty-panel--compact adm-state adm-state--empty"><p>暂无自动接受规则</p></div>
        </div>
      </section>

      <section class="dmgr-section adm-panel">
        <div class="dmgr-section-head">
          <span class="dmgr-section-title">定时任务</span>
          <Button variant="default" size="sm" @click="openAddTask">+ 新增</Button>
        </div>
        <div v-if="cronTasks.length" class="cron-list">
          <div v-for="task in cronTasks" :key="task.task_id" class="cron-row">
            <div class="cron-row-main">
              <div class="cron-meta">
                <span class="cron-name">{{ task.name || task.task_id }}</span>
                <code class="cron-expr">{{ task.cron }}</code>
                <UiBadge class="status-badge" size="sm" :tone="task.enabled ? 'success' : 'neutral'">{{ task.enabled ? '启用' : '禁用' }}</UiBadge>
              </div>
              <div class="cron-desc">{{ taskDesc(task.task) }}</div>
              <div class="cron-footer">
                <span class="cron-team">{{ task.team_name }}</span>
                <span v-if="task.push_platform" class="cron-push">→ {{ platformLabel(task.push_platform) }}</span>
                <span v-if="task.last_run" class="cron-time">上次: {{ formatTime(task.last_run) }}</span>
              </div>
            </div>
            <div class="cron-row-actions">
              <Button variant="secondary" size="icon" aria-label="手动触发" @click="handleTriggerTask(task.task_id)"><IconPlay :size="13" /></Button>
              <Button variant="secondary" size="icon" :aria-label="task.enabled ? '禁用' : '启用'" @click="handleToggleTask(task)">
                <IconPause v-if="task.enabled" :size="13" />
                <IconPlay v-else :size="13" />
              </Button>
              <Button variant="destructive" size="icon" aria-label="删除" @click="handleDeleteTask(task.task_id)"><IconClose :size="13" :stroke-width="2.5" /></Button>
            </div>
          </div>
        </div>
        <div v-else class="empty-panel adm-state adm-state--empty">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.35"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <p>暂无定时任务</p>
        </div>
      </section>

      <section class="dmgr-section adm-panel">
        <div class="dmgr-section-head"><span class="dmgr-section-title">主动推送</span></div>
        <div class="config-card">
          <div class="push-row">
            <div class="push-platform-select"><CustomSelect v-model="pushForm.platform" :options="PLATFORM_OPTIONS" /></div>
            <input v-model="pushForm.chat_id" class="form-ctrl" placeholder="目标 chat_id" />
          </div>
          <textarea v-model="pushForm.content" class="form-ctrl" placeholder="推送内容" rows="2"/>
          <div class="push-foot">
            <Button size="sm" variant="default" @click="handlePush" :disabled="pushSending || !pushForm.chat_id || !pushForm.content">{{ pushSending ? '发送中...' : '发送' }}</Button>
          </div>
        </div>
      </section>
    </div>

    <Dialog v-model:open="showConfigModal">
      <DialogContent class="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{{ configModalTitle }}</DialogTitle>
        </DialogHeader>
        <div class="adm-modal-form">
        <div v-if="isNewPlatform" class="form-item"><label class="form-label">平台</label><CustomSelect v-model="platformForm.key" :options="PLATFORM_OPTIONS" /></div>
        <div class="form-two-col">
          <div class="form-item"><label class="form-label">App ID</label><input v-model="platformForm.app_id" class="form-ctrl" placeholder="cli_xxxxxxxxxxxx" /></div>
          <div class="form-item"><label class="form-label">App Secret</label><input v-model="platformForm.app_secret" class="form-ctrl" type="password" placeholder="粘贴你的应用密钥" /></div>
        </div>
        <div class="form-item"><label class="form-label">接收方式</label><CustomSelect v-model="platformForm.receive_mode" :options="RECEIVE_MODE_OPTIONS" /><p class="section-tip">长连接无需公网地址；Webhook 需配置公网 HTTPS 回调。</p></div>
        <div class="form-two-col">
          <div class="form-item"><label class="form-label">事件订阅 Token</label><input v-model="platformForm.token" class="form-ctrl" placeholder="飞书事件订阅 Token" /></div>
          <div class="form-item"><label class="form-label">Encrypt Key（可选）</label><input v-model="platformForm.encoding_aes_key" class="form-ctrl" placeholder="未开启消息加密可留空" /></div>
        </div>
        <div class="form-two-col">
          <div class="form-item"><label class="form-label">Webhook URL（可选）</label><input v-model="platformForm.webhook_url" class="form-ctrl" placeholder="入站 Webhook 回调地址" /></div>
          <div class="form-item"><label class="form-label">平台级 Session ID（可选）</label><input v-model="platformForm.session_id" class="form-ctrl" placeholder="留空则使用 agent 级配置" /></div>
        </div>
      </div>
        <DialogFooter>
        <Button size="sm" @click="showConfigModal = false">取消</Button>
        <Button size="sm" variant="default" @click="savePlatformConfig" :disabled="configSaving">{{ configSaving ? '保存中...' : '保存' }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showAddTask">
      <DialogContent class="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>新增定时任务</DialogTitle>
        </DialogHeader>
        <div class="adm-modal-form">
        <div class="form-two-col">
          <div class="form-item"><label class="form-label">任务名称</label><input v-model="newTask.name" class="form-ctrl" placeholder="如：早间简报" /></div>
          <div class="form-item"><label class="form-label">Cron 表达式</label><input v-model="newTask.cron" class="form-ctrl" placeholder="0 9 * * 1-5" /><p class="section-tip">分 时 日 月 周，如 <code>0 9 * * 1-5</code> = 工作日早 9 点</p></div>
        </div>
        <div class="form-item"><label class="form-label">任务描述（传给 Agent）</label><textarea v-model="newTask.task" class="form-ctrl" placeholder="请生成今日简报..." rows="2"/></div>
        <div class="form-two-col">
          <div class="form-item"><label class="form-label">Team</label><CustomSelect v-model="newTask.team_name" :options="teamOptions" placeholder="default" /></div>
          <div class="form-item"><label class="form-label">入口 Agent（可选）</label><CustomSelect v-model="newTask.entry_agent" :options="agentOptions" placeholder="留空用 team 默认" /></div>
        </div>
        <div class="form-two-col">
          <div class="form-item"><label class="form-label">推送平台</label><CustomSelect v-model="newTask.push_platform" :options="PLATFORM_OPTIONS_WITH_NONE" placeholder="不推送" /></div>
          <div class="form-item"><label class="form-label">推送 chat_id</label><input v-model="newTask.push_chat_id" class="form-ctrl" placeholder="可选" /></div>
        </div>
      </div>
        <DialogFooter>
        <Button size="sm" @click="showAddTask = false">取消</Button>
        <Button size="sm" variant="default" @click="handleAddTask" :disabled="addTaskSaving">{{ addTaskSaving ? '创建中...' : '创建' }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showTestDialog">
      <DialogContent class="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ testDialogTitle }}</DialogTitle>
        </DialogHeader>
        <div class="adm-modal-form">
        <div class="form-item"><label class="form-label">Chat ID</label><input v-model="testForm.chat_id" class="form-ctrl" placeholder="真实 chat_id" /></div>
        <div class="form-item"><label class="form-label">消息内容</label><input v-model="testForm.content" class="form-ctrl" placeholder="测试消息" /></div>
      </div>
        <DialogFooter>
        <Button size="sm" @click="showTestDialog = false">取消</Button>
        <Button size="sm" variant="default" @click="handleTest" :disabled="testSending">{{ testSending ? '发送中...' : '发送' }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </PageLayout>
</template>

<script setup>
import { ref, computed, h, onMounted } from 'vue';
import PageLayout from '../components/PageLayout.vue';
import IconRefresh from '../components/icons/IconRefresh.vue';
import IconClose from '../components/icons/IconClose.vue';
import IconPlay from '../components/icons/IconPlay.vue';
import IconPause from '../components/icons/IconPause.vue';
import CustomSelect from '../components/ui/CustomSelect.vue';
import ToggleSwitch from '../components/ToggleSwitch.vue';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog';
import KpiCards from '../components/admin/KpiCards.vue';
import { UiBadge } from '../components/ui';
import { Button } from '../components/ui/button';
import { useToast } from '../composables/useToast.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import * as api from '../api/daemon';
import { useDictionariesStore } from '../stores/dictionaries.js';
import {
  AUTO_ACCEPT_PATTERN_OPTIONS,
  createEmptyAutoAcceptPattern,
  normalizePermissionPolicy,
  serializePermissionPolicy,
} from '../utils/permissionPresentation';

const toast = useToast();
const dictStore = useDictionariesStore();

const SVG = { xmlns: 'http://www.w3.org/2000/svg', width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' };
const IconAdapters = () => h('svg', SVG, [h('rect', { x: 2, y: 3, width: 20, height: 14, rx: 2 }), h('line', { x1: 8, y1: 21, x2: 16, y2: 21 }), h('line', { x1: 12, y1: 17, x2: 12, y2: 21 })]);
const IconCron = () => h('svg', SVG, [h('circle', { cx: 12, cy: 12, r: 10 }), h('polyline', { points: '12 6 12 12 16 14' })]);
const IconSessions = () => h('svg', SVG, [h('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' })]);

const PLATFORM_OPTIONS = [
  { value: 'feishu', label: '飞书' },
  { value: 'dingtalk', label: '钉钉' },
  { value: 'wechat', label: '企业微信' },
];
const PLATFORM_OPTIONS_WITH_NONE = [{ value: '', label: '不推送' }, ...PLATFORM_OPTIONS];
const RECEIVE_MODE_OPTIONS = [
  { value: 'long_connection', label: '长连接（推荐，无需公网）' },
  { value: 'webhook', label: 'Webhook（需要公网 HTTPS）' },
];
const PERM_MODE_OPTIONS = [
  { value: 'strict', label: 'strict（所有风险工具须审批）' },
  { value: 'standard', label: 'standard（medium+high 须审批）' },
  { value: 'relaxed', label: 'relaxed（仅 high 须审批）' },
  { value: 'dangerously_skip_permissions', label: 'dangerously_skip_permissions（跳过常规风险审批）' },
];
const autoAcceptPatternOptions = AUTO_ACCEPT_PATTERN_OPTIONS;

const teamOptions = ref([]);
const agentOptions = ref([]);
const loading = ref(false);
const status = ref({});
const agents = ref([]);
const cronTasks = ref([]);
const daemonConfig = ref(null);
const showAddTask = ref(false);
const showTestDialog = ref(false);
const showConfigModal = ref(false);
const isNewPlatform = ref(false);

const permForm = ref(normalizePermissionPolicy());
const newPatternForm = ref(createEmptyAutoAcceptPattern());
const baseForm = ref({ enabled: false, default_session_ttl: 86400, agent_session_id: '', team_name: 'default', entry_agent: '', heartbeat_interval: 30 });
const testTarget = ref({ team_name: '', platform: '' });
const testForm = ref({ chat_id: '', content: '测试消息' });
const pushForm = ref({ platform: 'feishu', chat_id: '', content: '' });
const newTask = ref({ name: '', cron: '', task: '', team_name: 'default', entry_agent: '', push_platform: null, push_chat_id: '' });
const platformForm = ref({ key: 'feishu', app_id: '', app_secret: '', token: '', encoding_aes_key: '', webhook_url: '', session_id: '', receive_mode: 'long_connection' });

const statusBadgeTone = computed(() => {
  if (status.value.running) return 'success';
  if (status.value.enabled) return 'warning';
  return 'neutral';
});
const statusBadgeText = computed(() => {
  if (status.value.running) return '运行中';
  if (status.value.enabled) return '已配置';
  return '未启用';
});
const cronTaskCount = computed(() => cronTasks.value.length);
const autoAcceptPatternCount = computed(() => permForm.value.auto_accept_patterns.length);
const isSkipAllApprovals = computed(() => Boolean(permForm.value.skip_all_approvals));
const platformConfigs = computed(() => {
  const agent = daemonConfig.value?.agents?.[0];
  if (!agent) return [];
  return Object.entries(agent.platforms || {}).map(([key, conn]) => {
    const extra = conn.extra || {};
    const extraFields = [];
    if (key === 'feishu') {
      extraFields.push({ key: 'receive_mode', label: '接收方式', value: extra.receive_mode === 'long_connection' ? '长连接' : 'Webhook' });
    }
    return { key, enabled: conn.enabled, app_id: conn.app_id, app_secret: conn.app_secret, extra_fields: extraFields };
  });
});
const statusKpis = computed(() => [
  { key: 'adapters', label: '已连接平台', value: status.value.adapter_count || 0, icon: IconAdapters },
  { key: 'cron', label: '定时任务', value: cronTaskCount.value, icon: IconCron },
  { key: 'sessions', label: '守护会话', value: status.value.daemon_sessions || 0, icon: IconSessions },
]);
const configModalTitle = computed(() => `${isNewPlatform.value ? '添加平台' : '编辑配置'} — ${platformLabel(platformForm.value.key)}`);
const testDialogTitle = computed(() => `测试 — ${platformLabel(testTarget.value.platform)}`);

function platformLabel(p) {
  const found = PLATFORM_OPTIONS.find((o) => o.value === p);
  return found ? found.label : p;
}
function statusLabel(s) {
  return { connected: '已连接', disconnected: '未连接', connecting: '连接中', error: '异常' }[s] || s;
}
function taskDesc(text) {
  if (!text) return '';
  return text.length > 80 ? text.slice(0, 80) + '...' : text;
}
function mask(val) {
  if (!val) return '';
  if (val.length <= 8) return '****';
  return val.slice(0, 4) + '****' + val.slice(-4);
}
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function patternTypeLabel(type) {
  return autoAcceptPatternOptions.find((option) => option.value === type)?.label || type;
}
function addAutoAcceptPattern() {
  const pattern = {
    pattern_type: newPatternForm.value.pattern_type,
    pattern_value: String(newPatternForm.value.pattern_value || '').trim(),
    description: String(newPatternForm.value.description || '').trim(),
  };
  if (!pattern.pattern_value) return;
  permForm.value.auto_accept_patterns = [...permForm.value.auto_accept_patterns, pattern];
  newPatternForm.value = createEmptyAutoAcceptPattern();
}
function removeAutoAcceptPattern(index) {
  permForm.value.auto_accept_patterns = permForm.value.auto_accept_patterns.filter((_, i) => i !== index);
}
function toggleSkipAllApprovals() {
  permForm.value.skip_all_approvals = !permForm.value.skip_all_approvals;
}

async function refresh() {
  loading.value = true;
  try {
    const [s, a, t, cfg] = await Promise.all([
      api.getStatus(),
      api.listAgents(),
      api.listCronTasks(),
      api.getConfig().catch(() => null),
    ]);
    status.value = s;
    agents.value = a;
    cronTasks.value = t;
    if (cfg) {
      daemonConfig.value = cfg;
      const agent = cfg.agents?.[0];
      baseForm.value = {
        enabled: !!cfg.enabled,
        default_session_ttl: cfg.default_session_ttl || 86400,
        agent_session_id: agent?.session_id || '',
        team_name: agent?.team_name || 'default',
        entry_agent: agent?.entry_agent || '',
        heartbeat_interval: agent?.heartbeat_interval || 30,
      };
      permForm.value = normalizePermissionPolicy(agent?.permissions || {});
      newPatternForm.value = createEmptyAutoAcceptPattern();
    }
  } catch (e) {
    toast.error(e?.message || '刷新失败');
  } finally {
    loading.value = false;
  }
}

async function toggleDaemon() {
  loading.value = true;
  try {
    if (status.value.running) {
      await api.stopDaemon();
      toast.success('守护系统已停止');
    } else {
      await api.startDaemon();
      toast.success('守护系统已启动');
    }
    await refresh();
  } catch (e) {
    toast.error(e?.message || '操作失败');
  } finally {
    loading.value = false;
  }
}

function ensureAgentEntry() {
  if (!daemonConfig.value) daemonConfig.value = { enabled: true, agents: [], default_session_ttl: 86400 };
  if (!daemonConfig.value.agents.length) {
    daemonConfig.value.agents.push({ team_name: 'default', entry_agent: null, enabled: true, platforms: {}, cron_tasks: [], heartbeat_interval: 30 });
  }
  return daemonConfig.value.agents[0];
}

const { run: runSaveBase, loading: baseSaving } = useAsyncAction(
  async () => {
    const agent = ensureAgentEntry();
    daemonConfig.value.enabled = !!baseForm.value.enabled;
    daemonConfig.value.default_session_ttl = Number(baseForm.value.default_session_ttl) || 86400;
    agent.team_name = baseForm.value.team_name || 'default';
    agent.entry_agent = baseForm.value.entry_agent || null;
    agent.session_id = baseForm.value.agent_session_id || null;
    agent.heartbeat_interval = Math.max(5, Number(baseForm.value.heartbeat_interval) || 30);
    await api.updateConfig(daemonConfig.value);
    await refresh();
  },
  { successMessage: '基础配置已保存', errorPrefix: '保存基础配置失败' },
);
function saveBaseConfig() { runSaveBase(); }

const { run: runSavePerm, loading: permSaving } = useAsyncAction(
  async () => {
    const agent = ensureAgentEntry();
    agent.permissions = serializePermissionPolicy(permForm.value);
    await api.updateConfig(daemonConfig.value);
    await refresh();
  },
  { successMessage: '权限配置已保存', errorPrefix: '保存权限配置失败' },
);
function savePermissions() { runSavePerm(); }

function openAddPlatform() {
  isNewPlatform.value = true;
  platformForm.value = { key: 'feishu', app_id: '', app_secret: '', token: '', encoding_aes_key: '', webhook_url: '', session_id: '', receive_mode: 'long_connection' };
  showConfigModal.value = true;
}
function openEditPlatform(platformKey) {
  isNewPlatform.value = false;
  const conn = daemonConfig.value?.agents?.[0]?.platforms?.[platformKey] || {};
  platformForm.value = {
    key: platformKey,
    app_id: conn.app_id || '',
    app_secret: conn.app_secret || '',
    token: conn.token || '',
    encoding_aes_key: conn.encoding_aes_key || '',
    webhook_url: conn.webhook_url || '',
    session_id: conn.session_id || '',
    receive_mode: conn.extra?.receive_mode || 'long_connection',
  };
  showConfigModal.value = true;
}

const { run: runSavePlatform, loading: configSaving } = useAsyncAction(
  async () => {
    const agent = ensureAgentEntry();
    const f = platformForm.value;
    const extra = { ...agent.platforms[f.key]?.extra, receive_mode: f.receive_mode || 'long_connection' };
    agent.platforms[f.key] = {
      enabled: true,
      app_id: f.app_id || null,
      app_secret: f.app_secret || null,
      token: f.token || null,
      encoding_aes_key: f.encoding_aes_key || null,
      webhook_url: f.webhook_url || null,
      session_id: f.session_id || null,
      extra,
    };
    await api.updateConfig(daemonConfig.value);
    showConfigModal.value = false;
    await refresh();
  },
  { successMessage: '平台配置已保存', errorPrefix: '保存配置失败' },
);
function savePlatformConfig() { runSavePlatform(); }

const { run: runTogglePlatform } = useAsyncAction(
  async (platformKey) => {
    const agent = daemonConfig.value?.agents?.[0];
    if (!agent?.platforms?.[platformKey]) return;
    agent.platforms[platformKey].enabled = !agent.platforms[platformKey].enabled;
    await api.updateConfig(daemonConfig.value);
    await refresh();
  },
  { errorPrefix: '更新失败' },
);
function togglePlatformEnabled(platformKey) { runTogglePlatform(platformKey); }

const { run: runRemovePlatform } = useAsyncAction(
  async (platformKey) => {
    const agent = daemonConfig.value?.agents?.[0];
    if (!agent?.platforms?.[platformKey]) return;
    delete agent.platforms[platformKey];
    await api.updateConfig(daemonConfig.value);
    await refresh();
  },
  { successMessage: '已移除平台', errorPrefix: '移除失败' },
);
function removePlatform(platformKey) { runRemovePlatform(platformKey); }

function openTestDialog(teamName, platform) {
  testTarget.value = { team_name: teamName, platform };
  testForm.value = { chat_id: '', content: '测试消息' };
  showTestDialog.value = true;
}
const { run: runTest, loading: testSending } = useAsyncAction(
  async () => {
    await api.testAgent(testTarget.value.team_name, {
      content: testForm.value.content,
      platform: testTarget.value.platform,
      chat_id: testForm.value.chat_id,
    });
    showTestDialog.value = false;
  },
  { successMessage: '测试消息已发送', errorPrefix: '测试失败' },
);
function handleTest() { runTest(); }

const { run: runPush, loading: pushSending } = useAsyncAction(
  async () => {
    await api.sendDaemonMessage(pushForm.value);
    pushForm.value.content = '';
  },
  { successMessage: '已推送', errorPrefix: '推送失败' },
);
function handlePush() { runPush(); }

function openAddTask() {
  newTask.value = { name: '', cron: '', task: '', team_name: 'default', entry_agent: '', push_platform: null, push_chat_id: '' };
  showAddTask.value = true;
}
const { run: runAddTask, loading: addTaskSaving } = useAsyncAction(
  async () => {
    await api.createCronTask({ ...newTask.value, task_id: 'cron_' + Date.now() });
    showAddTask.value = false;
    await refresh();
  },
  { successMessage: '任务已创建', errorPrefix: '创建任务失败' },
);
function handleAddTask() { runAddTask(); }

const { run: runTriggerTask } = useAsyncAction(
  async (taskId) => { await api.triggerCronTask(taskId); await refresh(); },
  { successMessage: '已触发', errorPrefix: '触发失败' },
);
function handleTriggerTask(taskId) { runTriggerTask(taskId); }

const { run: runToggleTask } = useAsyncAction(
  async (task) => { await api.updateCronTask(task.task_id, { enabled: !task.enabled }); await refresh(); },
  { errorPrefix: '更新失败' },
);
function handleToggleTask(task) { runToggleTask(task); }

const { run: runDeleteTask } = useAsyncAction(
  async (taskId) => { await api.deleteCronTask(taskId); await refresh(); },
  { successMessage: '已删除', errorPrefix: '删除失败' },
);
function handleDeleteTask(taskId) { runDeleteTask(taskId); }

async function loadTeamAgentOptions() {
  try {
    const [teamsData, agentsData] = await Promise.all([
      dictStore.ensureTeams().catch(() => ({ teams: [] })),
      dictStore.ensureAgents().catch(() => ({})),
    ]);
    teamOptions.value = (teamsData.teams || []).map((t) => ({ value: t.team_name || t, label: t.team_name || t }));
    agentOptions.value = Object.entries(agentsData || {}).map(([name, cfg]) => ({
      value: name,
      label: cfg?.display_name ? `${cfg.display_name} (${name})` : name,
    }));
  } catch (e) {
    toast.error('加载 Team/Agent 列表失败');
  }
}

onMounted(() => { refresh(); loadTeamAgentOptions(); });
</script>

<style scoped>
.hdr-actions { display: flex; align-items: center; gap: var(--spacing-sm); }
.btn-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff; animation: spin 0.6s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }

.dmgr { display: flex; flex-direction: column; gap: var(--spacing-xl); }
.dmgr-section { background: var(--color-bg-elevated); border: none; border-radius: var(--radius-lg); padding: var(--spacing-xl); display: flex; flex-direction: column; gap: var(--spacing-lg); box-shadow: none; }
.dmgr-section-head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); }
.dmgr-section-title { font-size: var(--font-size-lg); font-weight: 600; color: var(--color-text-primary); letter-spacing: -0.01em; }
.section-tip { font-size: var(--font-size-xs); color: var(--color-text-muted); margin: 0; line-height: 1.5; }
.section-tip code { font-family: var(--font-mono); background: var(--color-active-bg); color: var(--color-brand-accent); padding: 1px 6px; border-radius: var(--radius-sm); }
.status-badge { line-height: 1.4; }

.toggle-row { display: flex; align-items: center; gap: var(--spacing-sm); min-height: 40px; }

.config-card { background: var(--color-bg-secondary); border: none; border-radius: var(--radius-lg); padding: var(--spacing-lg); display: flex; flex-direction: column; gap: var(--spacing-lg); }
.config-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--spacing-lg); }

.form-item { display: flex; flex-direction: column; gap: 8px; }
.form-label { font-size: var(--font-size-xs); font-weight: 600; color: var(--color-text-secondary); letter-spacing: 0.01em; }
.form-ctrl { width: 100%; min-height: 40px; padding: 0 12px; border-radius: var(--control-radius); border: 1px solid var(--color-border); background: var(--color-bg-elevated); color: var(--color-text-primary); font-size: var(--font-size-sm); outline: none; box-sizing: border-box; transition: border-color var(--transition-fast), box-shadow var(--transition-fast); }
.form-ctrl:hover { border-color: var(--color-border-hover); }
.form-ctrl:focus { border-color: var(--color-brand-accent); box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.12); }
textarea.form-ctrl { padding: 10px 12px; resize: vertical; min-height: 80px; font-family: inherit; }
select.form-ctrl { cursor: pointer; }
.form-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: var(--spacing-lg); }
.adm-modal-form { display: flex; flex-direction: column; gap: var(--spacing-lg); }

.permission-toggle-row { margin-top: var(--spacing-xs); }
.permission-rule-head { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); }
.permission-rule-count { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.permission-rule-form { display: grid; grid-template-columns: 160px minmax(0, 1fr) minmax(0, 1fr) auto; gap: var(--spacing-sm); align-items: center; }
.permission-rule-list { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.permission-rule-item { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--radius-md); border: none; background: var(--color-bg-secondary); }
.permission-rule-main { display: flex; align-items: center; gap: var(--spacing-sm); min-width: 0; flex-wrap: wrap; }
.permission-rule-type { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: var(--radius-sm); border: none; background: var(--color-hover-overlay-lg); color: var(--color-text-secondary); font-size: var(--font-size-xs); font-weight: 600; }
.permission-rule-value { font-family: var(--font-mono); font-size: var(--font-size-xs); color: var(--color-text-primary); word-break: break-all; }
.permission-rule-desc { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.empty-panel--compact { padding: var(--spacing-lg) var(--spacing-md); }

.platform-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--spacing-md); }
.platform-card { border-radius: var(--radius-lg); border: none; background: var(--color-bg-secondary); padding: var(--spacing-lg); display: flex; flex-direction: column; gap: var(--spacing-sm); transition: box-shadow var(--transition-fast); }
.platform-card:hover { box-shadow: var(--shadow-elevated); }
.platform-card--active { box-shadow: inset 0 0 0 1px rgba(var(--color-success-rgb), 0.3); }
.platform-card-head { display: flex; align-items: center; gap: var(--spacing-sm); }
.platform-icon { width: 36px; height: 36px; border-radius: var(--radius-md); background: var(--color-hover-overlay-md); border: none; display: flex; align-items: center; justify-content: center; color: var(--color-text-secondary); flex-shrink: 0; }
.platform-name { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text-primary); flex: 1; }
.platform-fields { display: flex; flex-direction: column; gap: 6px; }
.platform-field { display: flex; justify-content: space-between; align-items: center; gap: var(--spacing-sm); }
.pf-lbl { font-size: var(--font-size-xs); color: var(--color-text-muted); flex-shrink: 0; }
.pf-val { font-size: var(--font-size-xs); color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-val.mono { font-family: var(--font-mono); }
.platform-card-foot { display: flex; gap: var(--spacing-sm); padding-top: var(--spacing-xs); }

.adapter-group { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.adapter-group-lbl { font-size: var(--font-size-xs); font-weight: 500; color: var(--color-text-muted); }
.adapter-row { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
.adapter-chip { display: inline-flex; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--control-radius); border: none; background: var(--color-hover-overlay-md); font-size: var(--font-size-sm); transition: background var(--transition-fast); }
.adapter-chip--connected { background: var(--color-success-bg); }
.adapter-chip--error { background: var(--color-error-bg); }
.adapter-chip--connecting { background: var(--color-warning-bg); }
.adp-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--color-text-muted); }
.adapter-chip--connected .adp-dot { background: var(--color-success); }
.adapter-chip--error .adp-dot { background: var(--color-error); }
.adapter-chip--connecting .adp-dot { background: var(--color-warning); animation: pulse 1s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
.adp-name { font-weight: 500; color: var(--color-text-primary); }
.adp-status { font-size: var(--font-size-xs); color: var(--color-text-muted); }

.cron-list { display: flex; flex-direction: column; border: none; border-radius: 0; overflow: hidden; }
.cron-row { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); padding: var(--spacing-md) 0; border-bottom: 1px solid var(--color-border); transition: background var(--transition-fast); }
.cron-row:first-child { border-top: 1px solid var(--color-border); }
.cron-row:hover { background: var(--color-hover-overlay-md); }
.cron-row-main { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; padding: 0 var(--spacing-sm); }
.cron-meta { display: flex; align-items: center; gap: var(--spacing-sm); flex-wrap: wrap; }
.cron-name { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text-primary); }
.cron-expr { font-family: var(--font-mono); font-size: var(--font-size-xs); border: none; background: var(--color-hover-overlay-md); color: var(--color-text-secondary); padding: 2px 8px; border-radius: var(--radius-sm); }
.cron-desc { font-size: var(--font-size-xs); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cron-footer { display: flex; align-items: center; gap: var(--spacing-sm); flex-wrap: wrap; }
.cron-team { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.cron-push { font-size: var(--font-size-xs); color: var(--color-brand-accent); }
.cron-time { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.cron-row-actions { display: flex; align-items: center; gap: var(--spacing-xs); flex-shrink: 0; }

.push-row { display: flex; gap: var(--spacing-sm); align-items: flex-start; }
.push-platform-select { width: 140px; flex-shrink: 0; }
.push-foot { display: flex; justify-content: flex-end; }

.empty-panel { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--spacing-sm); padding: var(--spacing-2xl) var(--spacing-lg); color: var(--color-text-muted); font-size: var(--font-size-sm); text-align: center; }
.empty-panel p { margin: 0; }

:deep(.select-trigger) { height: 40px; min-height: 40px; font-size: var(--font-size-sm); font-weight: 500; }

@media (max-width: 640px) {
  .config-grid { grid-template-columns: 1fr; }
  .form-two-col { grid-template-columns: 1fr; }
  .platform-grid { grid-template-columns: 1fr; }
  .push-row { flex-direction: column; }
  .cron-row { flex-direction: column; align-items: flex-start; }
  .cron-row-actions { align-self: flex-end; }
  .permission-rule-form { grid-template-columns: 1fr; }
  .permission-rule-item { align-items: flex-start; }
}
</style>
