<template>
  <PageLayout title="机器人" subtitle="私有自动化身份 · 飞书接入 · 定时任务">
    <template #header-actions>
      <Button variant="outline" size="sm" :disabled="loadAction.loading.value" @click="loadAction.run()">
        <IconRefresh data-icon="inline-start" />
        刷新
      </Button>
      <Button size="sm" @click="createDialogOpen = true">
        <IconPlus data-icon="inline-start" />
        新建机器人
      </Button>
    </template>

    <template #mobile-menu="{ close }">
      <button class="pl-menu-item" @click="loadAction.run(); close()">
        <IconRefresh :size="16" />
        刷新
      </button>
      <button class="pl-menu-item" @click="createDialogOpen = true; close()">
        <IconPlus :size="16" />
        新建机器人
      </button>
    </template>

    <div class="bots-layout">
      <Card class="bot-list-card">
        <CardHeader>
          <CardTitle>我的机器人</CardTitle>
          <CardDescription>每个机器人拥有独立身份、飞书连接与定时任务。</CardDescription>
        </CardHeader>
        <CardContent class="bot-list-content">
          <div v-if="loadAction.loading.value" class="empty-state">正在加载机器人…</div>
          <div v-else-if="bots.length === 0" class="empty-state">
            <p>尚未创建机器人</p>
            <Button variant="outline" size="sm" @click="createDialogOpen = true">
              <IconPlus data-icon="inline-start" />
              创建第一个机器人
            </Button>
          </div>
          <div v-else class="bot-list">
            <button
              v-for="bot in bots"
              :key="bot.id"
              class="bot-list-item"
              :class="{ active: bot.id === selectedBotId }"
              @click="selectBot(bot.id)"
            >
              <span class="connection-dot" :class="connectionClass(bot.config)" />
              <span class="bot-list-copy">
                <strong>{{ bot.displayName }}</strong>
                <small>{{ connectionLabel(bot.config) }}</small>
              </span>
            </button>
          </div>
        </CardContent>
      </Card>

      <div v-if="selectedBot" class="bot-detail">
        <Card>
          <CardHeader>
            <div class="card-heading-row">
              <div>
                <CardTitle>基础配置</CardTitle>
                <CardDescription>机器人名称、执行入口与会话派生策略。</CardDescription>
              </div>
              <div class="header-actions">
                <Button variant="outline" size="sm" @click="deleteDialogOpen = true">
                  <IconTrash data-icon="inline-start" />
                  删除
                </Button>
                <Button size="sm" :disabled="saveAction.loading.value" @click="saveAction.run()">
                  <IconSave data-icon="inline-start" />
                  {{ saveAction.loading.value ? '保存中…' : '保存全部' }}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent class="form-grid">
            <div class="form-item">
              <label for="bot-display-name">显示名称</label>
              <Input id="bot-display-name" v-model="form.displayName" />
            </div>
            <div class="form-item">
              <label>机器人状态</label>
              <div class="switch-field">
                <Badge :variant="form.enabled ? 'default' : 'secondary'">{{ form.enabled ? '已启用' : '已停用' }}</Badge>
                <Switch v-model:checked="form.enabled" aria-label="机器人总开关" />
              </div>
            </div>
            <div class="form-item">
              <label>入口 Agent</label>
              <CustomSelect v-model="form.entry_agent" :options="agentOptions" placeholder="使用默认 Agent" />
            </div>
            <div class="form-item">
              <label for="bot-session-id">固定 Session ID（可选）</label>
              <Input id="bot-session-id" v-model="form.session_id" placeholder="留空则按 bot + chat_id 派生" />
            </div>
            <div class="form-item">
              <label for="bot-session-ttl">默认会话 TTL（秒）</label>
              <Input id="bot-session-ttl" v-model.number="form.default_session_ttl" type="number" min="60" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div class="card-heading-row">
              <div>
                <CardTitle>飞书 IM</CardTitle>
                <CardDescription>配置机器人对应的飞书应用与消息接收方式。</CardDescription>
              </div>
              <div class="switch-field">
                <Badge :variant="form.feishu.enabled ? 'default' : 'secondary'">{{ form.feishu.enabled ? '已接入' : '未启用' }}</Badge>
                <Switch v-model:checked="form.feishu.enabled" aria-label="飞书连接开关" />
              </div>
            </div>
          </CardHeader>
          <CardContent class="form-grid">
            <div class="form-item">
              <label for="feishu-app-id">App ID</label>
              <Input id="feishu-app-id" v-model="form.feishu.app_id" class="input-mono" placeholder="cli_xxxxxxxxxxxx" />
            </div>
            <div class="form-item">
              <label for="feishu-app-secret">App Secret</label>
              <Input id="feishu-app-secret" v-model="form.feishu.app_secret" type="password" placeholder="已配置时留空可保留" />
            </div>
            <div class="form-item">
              <label for="feishu-token">Verification Token</label>
              <Input id="feishu-token" v-model="form.feishu.token" type="password" placeholder="已配置时留空可保留" />
            </div>
            <div class="form-item">
              <label for="feishu-encrypt-key">Encoding AES Key</label>
              <Input id="feishu-encrypt-key" v-model="form.feishu.encoding_aes_key" type="password" placeholder="已配置时留空可保留" />
            </div>
            <div class="form-item full">
              <label>接收模式</label>
              <CustomSelect v-model="form.feishu.receive_mode" :options="receiveModeOptions" />
            </div>
            <div class="form-item full">
              <label>Webhook 地址</label>
              <div class="webhook-box">
                <code>{{ webhookUrl || webhookPlaceholder }}</code>
                <Button v-if="webhookUrl" variant="outline" size="sm" @click="copyWebhook">
                  <IconCopy data-icon="inline-start" />
                  复制
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div class="card-heading-row">
              <div>
                <CardTitle>定时任务</CardTitle>
                <CardDescription>任务保存后按计划自动执行，也可手动触发。</CardDescription>
              </div>
              <Button size="sm" @click="openCronDialog()">
                <IconPlus data-icon="inline-start" />
                新建任务
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div v-if="cronTasks.length === 0" class="empty-state">暂无定时任务</div>
            <div v-else class="cron-list">
              <div v-for="task in cronTasks" :key="task.task_id" class="cron-item">
                <div class="cron-copy">
                  <div class="cron-title-row">
                    <strong>{{ task.task_id }}</strong>
                    <Badge variant="outline">{{ task.cron }}</Badge>
                    <Badge :variant="task.enabled ? 'default' : 'secondary'">{{ task.enabled ? '启用' : '停用' }}</Badge>
                  </div>
                  <p>{{ task.task }}</p>
                  <small>下次运行：{{ formatRunTime(task.next_run) || '未计划' }} · 最近结果：{{ task.last_result || '暂无' }}</small>
                </div>
                <div class="cron-actions">
                  <Button variant="ghost" size="icon-sm" title="编辑" aria-label="编辑" @click="openCronDialog(task)"><IconEdit /></Button>
                  <Button variant="ghost" size="icon-sm" title="立即触发" aria-label="立即触发" @click="triggerAction.run(task.task_id)"><IconPlay /></Button>
                  <Button variant="ghost" size="icon-sm" title="历史" aria-label="历史" @click="historyAction.run(task.task_id)">H</Button>
                  <Button variant="ghost" size="icon-sm" title="删除" aria-label="删除" @click="removeCronAction.run(task.task_id)"><IconTrash /></Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>调试与发送</CardTitle>
            <CardDescription>测试 Agent 执行，或通过当前飞书机器人主动发送文本消息。</CardDescription>
          </CardHeader>
          <CardContent class="debug-grid">
            <div class="debug-panel">
              <h3>测试执行</h3>
              <Input v-model="testForm.chat_id" placeholder="测试 chat_id" />
              <Textarea v-model="testForm.content" rows="4" placeholder="输入测试任务" />
              <Button :disabled="testAction.loading.value" @click="testAction.run()">
                <IconPlay data-icon="inline-start" />
                {{ testAction.loading.value ? '执行中…' : '执行测试' }}
              </Button>
              <pre v-if="testResult" class="debug-output">{{ testResult }}</pre>
            </div>
            <div class="debug-panel">
              <h3>发送飞书消息</h3>
              <Input v-model="sendForm.chat_id" placeholder="目标 chat_id" />
              <Textarea v-model="sendForm.content" rows="4" placeholder="消息内容" />
              <Button :disabled="sendAction.loading.value" @click="sendAction.run()">
                <IconSend data-icon="inline-start" />
                {{ sendAction.loading.value ? '发送中…' : '发送消息' }}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card v-else class="bot-placeholder">
        <CardHeader>
          <CardTitle>选择机器人</CardTitle>
          <CardDescription>从左侧选择机器人，或创建新的自动化身份。</CardDescription>
        </CardHeader>
      </Card>
    </div>

    <Dialog v-model:open="createDialogOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建机器人</DialogTitle>
          <DialogDescription>机器人仅对创建者可见，并自动成为当前租户的自动化成员。</DialogDescription>
        </DialogHeader>
        <div class="dialog-form">
          <label for="new-bot-name">显示名称</label>
          <Input id="new-bot-name" v-model="newBotName" placeholder="例如：飞书客服机器人" @keyup.enter="createAction.run()" />
        </div>
        <DialogFooter>
          <Button variant="outline" @click="createDialogOpen = false">取消</Button>
          <Button :disabled="createAction.loading.value || !newBotName.trim()" @click="createAction.run()">创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="cronDialogOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ editingCronId ? '编辑定时任务' : '新建定时任务' }}</DialogTitle>
          <DialogDescription>使用标准五段 Cron 表达式；任务保存后按计划自动执行，也可手动触发。</DialogDescription>
        </DialogHeader>
        <div class="dialog-form form-grid">
          <div class="form-item"><label>任务 ID</label><Input v-model="cronForm.task_id" :disabled="Boolean(editingCronId)" /></div>
          <div class="form-item"><label>Cron</label><Input v-model="cronForm.cron" class="input-mono" /></div>
          <div class="form-item full"><label>任务内容</label><Textarea v-model="cronForm.task" rows="4" /></div>
          <div class="form-item"><label>入口 Agent</label><CustomSelect v-model="cronForm.entry_agent" :options="agentOptions" placeholder="使用机器人默认 Agent" /></div>
          <div class="form-item"><label>推送 Chat ID（可选）</label><Input v-model="cronForm.push_chat_id" /></div>
          <div class="form-item full"><label>启用任务</label><Switch v-model:checked="cronForm.enabled" /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="cronDialogOpen = false">取消</Button>
          <Button :disabled="cronSaveAction.loading.value" @click="cronSaveAction.run()">保存任务</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="historyDialogOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>任务运行历史</DialogTitle>
          <DialogDescription>{{ historyTaskId }}</DialogDescription>
        </DialogHeader>
        <pre class="history-output">{{ historyText }}</pre>
      </DialogContent>
    </Dialog>

    <AlertDialog v-model:open="deleteDialogOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除机器人</AlertDialogTitle>
          <AlertDialogDescription>将同时删除该机器人的飞书配置与全部 Cron 任务，此操作不可撤销。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="deleteAction.loading.value">取消</AlertDialogCancel>
          <AlertDialogAction :disabled="deleteAction.loading.value" @click="deleteAction.run()">确认删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import PageLayout from '../components/PageLayout.vue';
import CustomSelect from '../components/ui/CustomSelect.vue';
import IconCopy from '../components/icons/IconCopy.vue';
import IconEdit from '../components/icons/IconEdit.vue';
import IconPlay from '../components/icons/IconPlay.vue';
import IconPlus from '../components/icons/IconPlus.vue';
import IconRefresh from '../components/icons/IconRefresh.vue';
import IconSave from '../components/icons/IconSave.vue';
import IconSend from '../components/icons/IconSend.vue';
import IconTrash from '../components/icons/IconTrash.vue';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../components/ui/alert-dialog';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { Textarea } from '../components/ui/textarea';
import * as botApi from '../api/bots.js';
import { getAllAgentConfigs } from '../api/agentConfig.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { useToast } from '../composables/useToast.js';

const toast = useToast();
const bots = ref([]);
const selectedBotId = ref('');
const agentNames = ref([]);
const cronTasks = ref([]);
const createDialogOpen = ref(false);
const cronDialogOpen = ref(false);
const historyDialogOpen = ref(false);
const deleteDialogOpen = ref(false);
const newBotName = ref('');
const editingCronId = ref('');
const historyTaskId = ref('');
const historyText = ref('暂无运行记录');
const testResult = ref('');

const form = reactive(emptyForm());
const cronForm = reactive(emptyCronForm());
const testForm = reactive({ chat_id: '', content: '你好，请介绍一下自己。' });
const sendForm = reactive({ chat_id: '', content: 'RAGSystem 飞书消息测试' });

const selectedBot = computed(() => bots.value.find(bot => bot.id === selectedBotId.value) || null);
const selectedConfig = computed(() => selectedBot.value?.config || null);
const agentOptions = computed(() => [
  { value: '', label: '使用默认 Agent' },
  ...agentNames.value.map(name => ({ value: name, label: name })),
]);
const receiveModeOptions = [
  { value: 'webhook', label: 'Webhook' },
  { value: 'long_connection', label: '长连接' },
];
const webhookUrl = computed(() => {
  if (form.feishu.receive_mode !== 'webhook' || !selectedConfig.value?.feishu?.route_token) return '';
  return `${window.location.origin}/api/bots/webhook/feishu/${selectedConfig.value.feishu.route_token}`;
});
const webhookPlaceholder = computed(() => form.feishu.receive_mode === 'webhook' ? '保存配置后生成 routeToken' : '长连接模式无需 Webhook 地址');

const loadAction = useAsyncAction(async () => {
  const [nextBots, configs] = await Promise.all([botApi.listBots(), getAllAgentConfigs()]);
  bots.value = nextBots;
  agentNames.value = Object.keys(configs || {});
  if (!selectedBotId.value || !bots.value.some(bot => bot.id === selectedBotId.value)) selectedBotId.value = bots.value[0]?.id || '';
  applySelectedBot();
}, { errorPrefix: '加载机器人失败' });

const createAction = useAsyncAction(async () => {
  const created = await botApi.createBot(newBotName.value.trim());
  createDialogOpen.value = false;
  newBotName.value = '';
  await loadAction.run();
  selectedBotId.value = created.id;
  applySelectedBot();
  return created;
}, { successMessage: '机器人已创建', errorPrefix: '创建机器人失败' });

const saveAction = useAsyncAction(async () => {
  const botId = requireBotId();
  await botApi.updateBot(botId, form.displayName.trim());
  await botApi.updateBotConfig(botId, buildConfigPayload());
  await refreshSelectedBot(botId);
}, { successMessage: '机器人配置已保存', errorPrefix: '保存机器人失败' });

const deleteAction = useAsyncAction(async () => {
  const botId = requireBotId();
  await botApi.deleteBot(botId);
  deleteDialogOpen.value = false;
  selectedBotId.value = '';
  await loadAction.run();
}, { successMessage: '机器人已删除', errorPrefix: '删除机器人失败' });

const cronSaveAction = useAsyncAction(async () => {
  const botId = requireBotId();
  const payload = buildCronPayload();
  if (editingCronId.value) await botApi.updateBotCronTask(botId, editingCronId.value, payload);
  else await botApi.createBotCronTask(botId, { task_id: cronForm.task_id.trim(), ...payload });
  cronDialogOpen.value = false;
  await loadCronTasks();
}, { successMessage: '定时任务已保存', errorPrefix: '保存定时任务失败' });

const removeCronAction = useAsyncAction(async taskId => {
  await botApi.deleteBotCronTask(requireBotId(), taskId);
  await loadCronTasks();
}, { successMessage: '定时任务已删除', errorPrefix: '删除定时任务失败' });

const triggerAction = useAsyncAction(async taskId => {
  const result = await botApi.triggerBotCronTask(requireBotId(), taskId);
  await loadCronTasks();
  return result;
}, { successMessage: '定时任务执行完成', errorPrefix: '触发定时任务失败' });

const historyAction = useAsyncAction(async taskId => {
  const result = await botApi.getBotCronHistory(requireBotId(), taskId);
  historyTaskId.value = taskId;
  historyText.value = result.history?.length ? JSON.stringify(result.history, null, 2) : '暂无运行记录';
  historyDialogOpen.value = true;
}, { errorPrefix: '加载运行历史失败' });

const testAction = useAsyncAction(async () => {
  const result = await botApi.testBot(requireBotId(), { content: testForm.content, platform: 'feishu', chat_id: testForm.chat_id || 'test_user' });
  testResult.value = result.result || JSON.stringify(result, null, 2);
}, { successMessage: '测试执行完成', errorPrefix: '测试执行失败' });

const sendAction = useAsyncAction(async () => botApi.sendBotMessage(requireBotId(), {
  platform: 'feishu',
  chat_id: sendForm.chat_id,
  content: sendForm.content,
  message_type: 'text',
}), { successMessage: '飞书消息已发送', errorPrefix: '发送飞书消息失败' });

function emptyForm() {
  return {
    displayName: '', enabled: false, entry_agent: '', session_id: '', default_session_ttl: 86400,
    feishu: { enabled: false, app_id: '', app_secret: '', token: '', encoding_aes_key: '', receive_mode: 'webhook' },
  };
}

function emptyCronForm() {
  return { task_id: '', cron: '0 9 * * 1-5', task: '', entry_agent: '', enabled: true, push_chat_id: '' };
}

function applySelectedBot() {
  const bot = selectedBot.value;
  const config = bot?.config;
  Object.assign(form, emptyForm(), {
    displayName: bot?.displayName || '',
    enabled: Boolean(config?.enabled),
    entry_agent: config?.entry_agent || '',
    session_id: config?.session_id || '',
    default_session_ttl: config?.default_session_ttl || 86400,
    feishu: {
      enabled: Boolean(config?.feishu?.enabled),
      app_id: config?.feishu?.app_id || '',
      app_secret: '',
      token: '',
      encoding_aes_key: '',
      receive_mode: config?.feishu?.receive_mode || 'webhook',
    },
  });
  cronTasks.value = config?.cron_tasks || [];
  testResult.value = '';
}

async function selectBot(botId) {
  selectedBotId.value = botId;
  applySelectedBot();
  await loadCronTasks();
}

async function refreshSelectedBot(botId) {
  const detail = await botApi.getBot(botId);
  const index = bots.value.findIndex(bot => bot.id === botId);
  const next = { ...detail.bot, config: detail.config };
  if (index >= 0) bots.value.splice(index, 1, next);
  else bots.value.push(next);
  selectedBotId.value = botId;
  applySelectedBot();
}

async function loadCronTasks() {
  if (!selectedBotId.value) return;
  cronTasks.value = await botApi.listBotCronTasks(selectedBotId.value);
  if (selectedBot.value) selectedBot.value.config.cron_tasks = cronTasks.value;
}

function buildConfigPayload() {
  const feishu = {
    enabled: Boolean(form.feishu.enabled),
    app_id: form.feishu.app_id || null,
    receive_mode: form.feishu.receive_mode,
  };
  if (form.feishu.app_secret) feishu.app_secret = form.feishu.app_secret;
  if (form.feishu.token) feishu.token = form.feishu.token;
  if (form.feishu.encoding_aes_key) feishu.encoding_aes_key = form.feishu.encoding_aes_key;
  return {
    enabled: Boolean(form.enabled),
    entry_agent: form.entry_agent || null,
    session_id: form.session_id || null,
    default_session_ttl: Number(form.default_session_ttl) || 86400,
    feishu,
  };
}

function buildCronPayload() {
  return {
    cron: cronForm.cron.trim(),
    task: cronForm.task.trim(),
    entry_agent: cronForm.entry_agent || null,
    enabled: Boolean(cronForm.enabled),
    push_platform: cronForm.push_chat_id ? 'feishu' : null,
    push_chat_id: cronForm.push_chat_id || null,
  };
}

function openCronDialog(task = null) {
  editingCronId.value = task?.task_id || '';
  Object.assign(cronForm, emptyCronForm(), task ? {
    task_id: task.task_id,
    cron: task.cron,
    task: task.task,
    entry_agent: task.entry_agent || '',
    enabled: Boolean(task.enabled),
    push_chat_id: task.push_chat_id || '',
  } : {});
  cronDialogOpen.value = true;
}

function requireBotId() {
  if (!selectedBotId.value) throw new Error('请先选择机器人');
  return selectedBotId.value;
}

function connectionLabel(config) {
  if (!config?.enabled) return '机器人已停用';
  if (!config?.feishu?.enabled) return '飞书未启用';
  return config.feishu.receive_mode === 'long_connection' ? '飞书长连接' : '飞书 Webhook';
}

function connectionClass(config) {
  return config?.enabled && config?.feishu?.enabled ? 'connected' : 'disconnected';
}

function formatRunTime(unixSeconds) {
  if (!unixSeconds) return '';
  return new Date(unixSeconds * 1000).toLocaleString();
}

async function copyWebhook() {
  try {
    await navigator.clipboard.writeText(webhookUrl.value);
    toast.success('Webhook 地址已复制');
  } catch {
    toast.error('复制失败，请手动复制');
  }
}

onMounted(() => loadAction.run());
</script>

<style scoped>
.bots-layout { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); gap: var(--spacing-lg); align-items: start; }
.bot-list-card { position: sticky; top: var(--spacing-md); }
.bot-list-content, .bot-list, .bot-detail, .cron-list, .dialog-form { display: flex; flex-direction: column; gap: var(--spacing-md); }
.bot-list-item { width: 100%; display: flex; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-sm); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-elevated); color: var(--color-text-primary); text-align: left; cursor: pointer; transition: border-color var(--transition-fast), background var(--transition-fast); }
.bot-list-item:hover, .bot-list-item.active { border-color: var(--color-brand-accent); background: var(--color-active-bg); }
.connection-dot { width: 8px; height: 8px; flex-shrink: 0; border-radius: var(--radius-full); background: var(--color-text-muted); }
.connection-dot.connected { background: var(--color-success); box-shadow: 0 0 0 4px rgba(var(--color-success-rgb), 0.12); }
.bot-list-copy { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 2px; }
.bot-list-copy strong, .bot-list-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bot-list-copy small { color: var(--color-text-muted); }
.card-heading-row, .header-actions, .switch-field, .cron-title-row, .cron-actions, .webhook-box { display: flex; align-items: center; gap: var(--spacing-sm); }
.card-heading-row { justify-content: space-between; align-items: flex-start; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }
.form-item { display: flex; flex-direction: column; gap: var(--spacing-xs); min-width: 0; }
.form-item.full { grid-column: 1 / -1; }
.form-item label, .dialog-form label { color: var(--color-text-secondary); font-size: var(--font-size-sm); font-weight: 600; }
.input-mono, .webhook-box code { font-family: var(--font-mono); }
.webhook-box { justify-content: space-between; padding: var(--spacing-sm); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-hover-overlay-md); }
.webhook-box code { min-width: 0; overflow-wrap: anywhere; color: var(--color-brand-accent); font-size: var(--font-size-xs); }
.cron-item { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); padding: var(--spacing-md); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-hover-overlay); }
.cron-copy { min-width: 0; }
.cron-copy p { margin: var(--spacing-xs) 0; color: var(--color-text-secondary); }
.cron-copy small { color: var(--color-text-muted); }
.debug-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }
.debug-panel { display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-md); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-hover-overlay); }
.debug-panel h3 { margin: 0; font-size: var(--font-size-sm); }
.debug-output, .history-output { max-height: 320px; overflow: auto; white-space: pre-wrap; padding: var(--spacing-md); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-hover-overlay-lg); color: var(--color-text-secondary); font-family: var(--font-mono); font-size: var(--font-size-xs); }
.empty-state { display: flex; flex-direction: column; align-items: center; gap: var(--spacing-md); padding: var(--spacing-xl) var(--spacing-md); color: var(--color-text-muted); text-align: center; }
.empty-state p { margin: 0; }
.bot-placeholder { min-height: 180px; }
@media (max-width: 960px) {
  .bots-layout { grid-template-columns: 1fr; }
  .bot-list-card { position: static; }
}
@media (max-width: 720px) {
  .form-grid, .debug-grid { grid-template-columns: 1fr; }
  .form-item.full { grid-column: auto; }
  .card-heading-row, .cron-item { flex-direction: column; align-items: stretch; }
  .header-actions, .cron-actions { flex-wrap: wrap; }
}
</style>
