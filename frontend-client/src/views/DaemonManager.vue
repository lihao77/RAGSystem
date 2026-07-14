<template>
  <PageLayout title="守护 Agent" subtitle="飞书 IM · 定时调度">
    <template #header-actions>
      <Button variant="ghost" size="icon-sm" aria-label="刷新" title="刷新" :disabled="loading" @click="refresh">
        <IconRefresh :size="16" />
      </Button>
    </template>

    <template #mobile-menu="{ close }">
      <button class="pl-menu-item" :disabled="loading" @click="refresh(); close()">
        <IconRefresh :size="16" />
        刷新
      </button>
    </template>

    <div class="dmgr">
      <Card>
        <CardHeader>
          <div class="card-head">
            <div class="card-head__title">
              <CardTitle>基础配置</CardTitle>
              <CardDescription>守护进程总开关与会话派生参数</CardDescription>
            </div>
            <Button size="sm" :disabled="saving" @click="saveConfig">
              <IconSave :size="16" />
              {{ saving ? '保存中…' : '保存' }}
            </Button>
          </div>
        </CardHeader>
        <CardContent class="form-grid">
          <div class="form-item">
            <label class="form-label">守护系统</label>
            <div class="status-field">
              <span class="status-pill" :class="form.enabled ? 'is-on' : 'is-off'">
                <span class="status-dot" />
                {{ form.enabled ? '运行中' : '未启用' }}
              </span>
              <Switch v-model:checked="form.enabled" aria-label="守护系统开关" />
            </div>
          </div>
          <div class="form-item"><label class="form-label">默认会话 TTL（秒）</label><Input v-model.number="form.default_session_ttl" type="number" min="60" /></div>
          <div class="form-item"><label class="form-label">Team 名称</label><Input v-model="form.team_name" placeholder="default" /></div>
          <div class="form-item"><label class="form-label">入口 Agent</label><Input v-model="form.entry_agent" placeholder="留空使用 team 默认入口" /></div>
          <div class="form-item full"><label class="form-label">Agent 级 Session ID（可选）</label><Input v-model="form.agent_session_id" placeholder="留空则按 team + chat_id 派生" /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div class="card-head">
            <div class="card-head__title">
              <CardTitle>飞书 IM</CardTitle>
              <CardDescription>接收飞书消息并触发 Agent 执行</CardDescription>
            </div>
            <div class="status-field">
              <span class="status-pill" :class="form.feishu.enabled ? 'is-on' : 'is-off'">
                <span class="status-dot" />
                {{ form.feishu.enabled ? '已接入' : '未启用' }}
              </span>
              <Switch v-model:checked="form.feishu.enabled" aria-label="飞书开关" />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div class="form-grid">
            <div class="form-item"><label class="form-label">App ID</label><Input v-model="form.feishu.app_id" class="input-mono" placeholder="cli_xxxxxxxxxxxx" /></div>
            <div class="form-item"><label class="form-label">App Secret</label><Input v-model="form.feishu.app_secret" type="password" placeholder="飞书应用密钥" /></div>
            <div class="form-item"><label class="form-label">Verification Token</label><Input v-model="form.feishu.token" type="password" placeholder="事件订阅 Token" /></div>
            <div class="form-item"><label class="form-label">Encrypt Key（可选）</label><Input v-model="form.feishu.encoding_aes_key" type="password" placeholder="未加密可留空" /></div>
            <div class="form-item full"><label class="form-label">接收模式</label><CustomSelect v-model="form.feishu.receive_mode" :options="RECEIVE_MODE_OPTIONS" /></div>
            <div class="form-item full"><label class="form-label">平台级 Session ID（可选）</label><Input v-model="form.feishu.session_id" placeholder="留空则使用 Agent 级配置" /></div>
          </div>
          <div class="webhook-box">
            <div class="webhook-head">
              <div class="webhook-head__text">
                <div class="form-label">{{ form.feishu.receive_mode === 'webhook' ? '事件订阅请求地址' : '长连接模式' }}</div>
                <p class="section-tip">{{ webhookTip }}</p>
              </div>
              <Button v-if="form.feishu.receive_mode === 'webhook' && webhookUrl" variant="ghost" size="icon-sm" class="copy-btn" aria-label="复制地址" title="复制地址" @click="copyWebhook">
                <IconCopy :size="16" />
              </Button>
            </div>
            <code v-if="form.feishu.receive_mode === 'webhook'">{{ webhookUrl || '保存配置后生成 routeToken' }}</code>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>消息调试</CardTitle>
          <CardDescription>手动触发 Agent 或向飞书会话推送文本</CardDescription>
        </CardHeader>
        <CardContent class="debug-grid">
          <div class="debug-panel">
            <div class="debug-panel__head"><IconSend :size="14" /><h3>Agent 测试</h3></div>
            <Input v-model="testForm.chat_id" placeholder="chat_id（用于会话派生）" />
            <Textarea v-model="testForm.content" rows="3" placeholder="发送给 Agent 的测试任务" />
            <Button size="sm" :disabled="testing" @click="runTest">{{ testing ? '执行中…' : '执行测试' }}</Button>
            <pre v-if="testResult" class="debug-output">{{ testResult }}</pre>
          </div>
          <div class="debug-panel">
            <div class="debug-panel__head"><IconSend :size="14" /><h3>飞书发送</h3></div>
            <Input v-model="sendForm.chat_id" placeholder="飞书 chat_id" />
            <Textarea v-model="sendForm.content" rows="3" placeholder="要发送的文本" />
            <Button size="sm" :disabled="sending" @click="runSend">{{ sending ? '发送中…' : '发送消息' }}</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div class="card-head">
            <div class="card-head__title">
              <CardTitle>定时任务</CardTitle>
              <CardDescription>按 Cron 表达式定时触发 Agent 执行</CardDescription>
            </div>
            <Button size="sm" @click="openAddTask"><IconPlus :size="16" />新增任务</Button>
          </div>
        </CardHeader>
        <CardContent>
          <div v-if="cronTasks.length" class="cron-list">
            <div v-for="task in cronTasks" :key="task.task_id" class="cron-row" :class="{ 'is-off': !task.enabled }">
              <div class="cron-main">
                <div class="cron-title">
                  <strong>{{ task.name || task.task_id }}</strong>
                  <code class="cron-chip">{{ task.cron }}</code>
                  <span v-if="!task.enabled" class="cron-off-tag">已停用</span>
                </div>
                <p class="cron-task">{{ task.task }}</p>
                <div class="cron-meta">
                  <span>Team · {{ task.team_name }}</span>
                  <span v-if="task.push_chat_id">推送 · {{ task.push_chat_id }}</span>
                  <span v-if="task.next_run">下次 · {{ formatRunTime(task.next_run) }}</span>
                  <span v-if="task.last_run">上次 · {{ formatRunTime(task.last_run) }}</span>
                </div>
              </div>
              <div class="cron-actions">
                <Switch :checked="task.enabled" :aria-label="`任务 ${task.task_id} 开关`" @update:checked="toggleTask(task)" />
                <Button variant="ghost" size="icon-sm" title="立即执行" @click="triggerTask(task.task_id)"><IconPlay :size="16" /></Button>
                <Button variant="ghost" size="icon-sm" title="执行历史" @click="showHistory(task.task_id)"><IconDocument :size="16" /></Button>
                <Button variant="action-danger" size="icon-sm" title="删除任务" @click="removeTask(task.task_id)"><IconTrash :size="16" /></Button>
              </div>
            </div>
          </div>
          <div v-else class="empty">
            <p>暂无定时任务</p>
            <Button size="sm" variant="outline" @click="openAddTask"><IconPlus :size="16" />创建首个任务</Button>
          </div>
        </CardContent>
      </Card>
    </div>

    <Dialog v-model:open="showAddTask">
      <DialogContent class="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>新增定时任务</DialogTitle>
          <DialogDescription>配置触发时间与 Agent 任务内容</DialogDescription>
        </DialogHeader>
        <div class="dialog-form">
          <div class="form-grid">
            <div class="form-item"><label class="form-label">任务名称</label><Input v-model="newTask.name" placeholder="早间简报" /></div>
            <div class="form-item"><label class="form-label">Cron 表达式</label><Input v-model="newTask.cron" class="input-mono" placeholder="0 9 * * 1-5" /></div>
            <div class="form-item full"><label class="form-label">任务内容</label><Textarea v-model="newTask.task" rows="3" placeholder="请生成今日简报" /></div>
            <div class="form-item"><label class="form-label">入口 Agent（可选）</label><Input v-model="newTask.entry_agent" /></div>
            <div class="form-item"><label class="form-label">飞书推送 chat_id（可选）</label><Input v-model="newTask.push_chat_id" /></div>
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" @click="showAddTask = false">取消</Button>
          <Button size="sm" :disabled="creating" @click="createTask">{{ creating ? '创建中…' : '创建' }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showHistoryDialog">
      <DialogContent class="max-w-[620px]">
        <DialogHeader>
          <DialogTitle>执行历史</DialogTitle>
          <DialogDescription>最近 20 次执行记录</DialogDescription>
        </DialogHeader>
        <pre class="history-output">{{ historyText }}</pre>
        <DialogFooter><Button size="sm" variant="ghost" @click="showHistoryDialog = false">关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import PageLayout from '../components/PageLayout.vue';
import IconCopy from '../components/icons/IconCopy.vue';
import IconDocument from '../components/icons/IconDocument.vue';
import IconPlay from '../components/icons/IconPlay.vue';
import IconPlus from '../components/icons/IconPlus.vue';
import IconRefresh from '../components/icons/IconRefresh.vue';
import IconSave from '../components/icons/IconSave.vue';
import IconSend from '../components/icons/IconSend.vue';
import IconTrash from '../components/icons/IconTrash.vue';
import CustomSelect from '../components/ui/CustomSelect.vue';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';
import { useToast } from '../composables/useToast.js';
import * as api from '../api/daemon';

const toast = useToast();
const RECEIVE_MODE_OPTIONS = [
  { value: 'long_connection', label: '长连接（推荐本地）' },
  { value: 'webhook', label: 'Webhook（需公网 URL）' },
];
const loading = ref(false);
const saving = ref(false);
const testing = ref(false);
const sending = ref(false);
const creating = ref(false);
const config = ref(null);
const cronTasks = ref([]);
const showAddTask = ref(false);
const showHistoryDialog = ref(false);
const historyText = ref('');
const testResult = ref('');

const emptyFeishu = () => ({ enabled: false, app_id: '', app_secret: '', token: '', encoding_aes_key: '', session_id: '', route_token: null, receive_mode: 'long_connection', extra: {} });
const form = ref({ enabled: false, default_session_ttl: 86400, team_name: 'default', entry_agent: '', agent_session_id: '', feishu: emptyFeishu() });
const testForm = ref({ chat_id: '', content: '你好，请介绍一下自己。' });
const sendForm = ref({ chat_id: '', content: 'RAGSystem 飞书消息测试' });
const newTask = ref(createEmptyTask());

const webhookUrl = computed(() => {
  if (form.value.feishu.receive_mode !== 'webhook') return '';
  const token = form.value.feishu.route_token;
  return token ? `${window.location.origin}/api/daemon/webhook/feishu/${token}` : '';
});

const webhookTip = computed(() => form.value.feishu.receive_mode === 'webhook'
  ? '复制到飞书开放平台的事件订阅配置；路径中的 routeToken 为随机不透明租户路由。'
  : 'daemon 主动连接飞书 WebSocket，无需公网地址；SDK 自动处理断线重连。');

async function copyWebhook() {
  if (!webhookUrl.value) return;
  try {
    await navigator.clipboard.writeText(webhookUrl.value);
    toast.success('Webhook 地址已复制');
  } catch {
    toast.error('复制失败，请手动选择复制');
  }
}

function formatRunTime(unixSeconds) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function createEmptyTask() {
  return { name: '', cron: '0 9 * * 1-5', task: '', entry_agent: '', push_chat_id: '' };
}

function applyConfig(next) {
  config.value = next;
  const agent = next?.agents?.[0] || {};
  const feishu = agent.platforms?.feishu || emptyFeishu();
  form.value = {
    enabled: !!next?.enabled,
    default_session_ttl: next?.default_session_ttl || 86400,
    team_name: agent.team_name || 'default',
    entry_agent: agent.entry_agent || '',
    agent_session_id: agent.session_id || '',
    feishu: { ...emptyFeishu(), ...feishu },
  };
}

async function refresh() {
  loading.value = true;
  try {
    const [nextConfig, tasks] = await Promise.all([api.getConfig(), api.listCronTasks()]);
    applyConfig(nextConfig);
    cronTasks.value = tasks || [];
  } catch (error) {
    toast.error(error?.message || '刷新失败');
  } finally {
    loading.value = false;
  }
}

async function saveConfig() {
  saving.value = true;
  try {
    const previousAgent = config.value?.agents?.[0] || {};
    const previousConnection = previousAgent.platforms?.feishu || {};
    const payload = {
      enabled: !!form.value.enabled,
      default_session_ttl: Number(form.value.default_session_ttl) || 86400,
      agents: [{
        ...previousAgent,
        team_name: form.value.team_name || 'default',
        entry_agent: form.value.entry_agent || null,
        session_id: form.value.agent_session_id || null,
        enabled: true,
        permissions: previousAgent.permissions || {},
        heartbeat_interval: previousAgent.heartbeat_interval || 30,
        cron_tasks: previousAgent.cron_tasks || [],
        platforms: {
          feishu: {
            ...previousConnection,
            ...form.value.feishu,
            app_id: form.value.feishu.app_id || null,
            app_secret: form.value.feishu.app_secret || null,
            token: form.value.feishu.token || null,
            encoding_aes_key: form.value.feishu.encoding_aes_key || null,
            session_id: form.value.feishu.session_id || null,
            webhook_url: null,
          },
        },
      }],
    };
    await api.updateConfig(payload);
    toast.success('配置已保存并生效');
    await refresh();
  } catch (error) {
    toast.error(error?.message || '保存失败');
  } finally {
    saving.value = false;
  }
}

async function runTest() {
  testing.value = true;
  testResult.value = '';
  try {
    const result = await api.testAgent(form.value.team_name || 'default', { content: testForm.value.content, platform: 'feishu', chat_id: testForm.value.chat_id || 'test' });
    testResult.value = result.result || '';
    toast.success('Agent 测试完成');
  } catch (error) {
    toast.error(error?.message || '测试失败');
  } finally {
    testing.value = false;
  }
}

async function runSend() {
  sending.value = true;
  try {
    const result = await api.sendDaemonMessage({ platform: 'feishu', chat_id: sendForm.value.chat_id, content: sendForm.value.content, message_type: 'text' });
    if (result.status === 'failed') throw new Error(result.error || '发送失败');
    toast.success('飞书消息已发送');
  } catch (error) {
    toast.error(error?.message || '发送失败');
  } finally {
    sending.value = false;
  }
}

function openAddTask() {
  newTask.value = createEmptyTask();
  showAddTask.value = true;
}

async function createTask() {
  creating.value = true;
  try {
    await api.createCronTask({
      task_id: `cron_${Date.now()}`,
      name: newTask.value.name,
      cron: newTask.value.cron,
      task: newTask.value.task,
      team_name: form.value.team_name || 'default',
      entry_agent: newTask.value.entry_agent || null,
      push_platform: newTask.value.push_chat_id ? 'feishu' : null,
      push_chat_id: newTask.value.push_chat_id || null,
      enabled: true,
    });
    showAddTask.value = false;
    toast.success('定时任务已创建');
    await refresh();
  } catch (error) {
    toast.error(error?.message || '创建失败');
  } finally {
    creating.value = false;
  }
}

async function toggleTask(task) {
  try {
    await api.updateCronTask(task.task_id, { enabled: !task.enabled });
    await refresh();
  } catch (error) {
    toast.error(error?.message || '更新失败');
  }
}

async function triggerTask(taskId) {
  try {
    await api.triggerCronTask(taskId);
    toast.success('任务执行完成');
    await refresh();
  } catch (error) {
    toast.error(error?.message || '执行失败');
  }
}

async function removeTask(taskId) {
  try {
    await api.deleteCronTask(taskId);
    toast.success('任务已删除');
    await refresh();
  } catch (error) {
    toast.error(error?.message || '删除失败');
  }
}

async function showHistory(taskId) {
  try {
    const result = await api.getCronTaskHistory(taskId, 20);
    historyText.value = JSON.stringify(result.history || [], null, 2);
    showHistoryDialog.value = true;
  } catch (error) {
    toast.error(error?.message || '读取历史失败');
  }
}

onMounted(refresh);
</script>

<style scoped>
.dmgr { display: flex; flex-direction: column; gap: var(--spacing-lg); }

.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing-md); }
.card-head__title { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }
.form-item { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.form-item.full { grid-column: 1 / -1; }
.form-label { color: var(--color-text-secondary); font-size: var(--font-size-sm); font-weight: 600; }
.section-tip { margin: 4px 0 0; color: var(--color-text-muted); font-size: var(--font-size-xs); line-height: 1.5; }
.input-mono { font-family: var(--font-mono); }

/* 启用状态：脉冲点 + 文字 + 开关 */
.status-field { display: flex; align-items: center; gap: var(--spacing-sm); }
.status-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: var(--radius-full); font-size: var(--font-size-xs); font-weight: 600; line-height: 1.4; }
.status-pill.is-on { background: rgba(var(--color-success-rgb), 0.12); color: var(--color-success); }
.status-pill.is-off { background: var(--color-hover-overlay-md); color: var(--color-text-muted); }
.status-dot { width: 7px; height: 7px; border-radius: var(--radius-full); background: currentColor; flex-shrink: 0; }
.status-pill.is-on .status-dot { animation: dmgr-pulse 2.4s ease-out infinite; }
@keyframes dmgr-pulse {
  0% { box-shadow: 0 0 0 0 rgba(var(--color-success-rgb), 0.5); }
  70% { box-shadow: 0 0 0 6px rgba(var(--color-success-rgb), 0); }
  100% { box-shadow: 0 0 0 0 rgba(var(--color-success-rgb), 0); }
}
@media (prefers-reduced-motion: reduce) {
  .status-pill.is-on .status-dot { animation: none; }
}

/* webhook 地址块 */
.webhook-box { display: flex; flex-direction: column; gap: var(--spacing-sm); margin-top: var(--spacing-lg); padding: var(--spacing-md); background: var(--color-hover-overlay-md); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.webhook-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing-sm); }
.webhook-head__text { min-width: 0; }
.webhook-box code { display: block; overflow-wrap: anywhere; color: var(--color-brand-accent); font-family: var(--font-mono); font-size: var(--font-size-xs); background: rgba(var(--color-brand-accent-rgb), 0.08); padding: 8px 12px; border-radius: var(--radius-sm); }
.copy-btn { flex-shrink: 0; }

/* 消息调试 */
.debug-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }
.debug-panel { display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-md); background: var(--color-hover-overlay-md); border-radius: var(--radius-md); }
.debug-panel__head { display: flex; align-items: center; gap: 6px; color: var(--color-text-secondary); }
.debug-panel__head h3 { margin: 0; font-size: var(--font-size-sm); font-weight: 600; }
.debug-output, .history-output { max-height: 320px; overflow: auto; white-space: pre-wrap; margin: 0; padding: var(--spacing-md); background: var(--color-hover-overlay-lg); border: 1px solid var(--color-border); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: var(--font-size-xs); color: var(--color-text-secondary); }

/* 定时任务列表 */
.cron-list { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.cron-row { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); padding: var(--spacing-md); background: var(--color-hover-overlay-md); border: 1px solid transparent; border-radius: var(--radius-md); transition: border-color 0.15s ease, background 0.15s ease; }
.cron-row:hover { border-color: var(--color-border); }
.cron-row.is-off { opacity: 0.55; }
.cron-main { min-width: 0; }
.cron-title { display: flex; align-items: center; gap: var(--spacing-sm); flex-wrap: wrap; }
.cron-title strong { font-size: var(--font-size-sm); }
.cron-chip { padding: 2px 8px; border-radius: var(--radius-full); background: rgba(var(--color-brand-accent-rgb), 0.1); color: var(--color-brand-accent); font-family: var(--font-mono); font-size: var(--font-size-xs); }
.cron-off-tag { padding: 1px 8px; border-radius: var(--radius-full); background: var(--color-hover-overlay-lg); color: var(--color-text-muted); font-size: var(--font-size-xs); }
.cron-task { margin: 6px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-sm); }
.cron-meta { display: flex; flex-wrap: wrap; gap: var(--spacing-sm) var(--spacing-md); margin-top: 6px; color: var(--color-text-muted); font-size: var(--font-size-xs); }
.cron-actions { display: flex; align-items: center; gap: var(--spacing-xs); flex-shrink: 0; }

/* 空状态 */
.empty { display: flex; flex-direction: column; align-items: center; gap: var(--spacing-md); padding: var(--spacing-2xl) var(--spacing-md); color: var(--color-text-muted); }
.empty p { margin: 0; }

.dialog-form { padding: var(--spacing-sm) 0; }

@media (max-width: 720px) {
  .form-grid, .debug-grid { grid-template-columns: 1fr; }
  .form-item.full { grid-column: auto; }
  .cron-row { align-items: flex-start; flex-direction: column; }
  .cron-actions { flex-wrap: wrap; }
}
</style>
