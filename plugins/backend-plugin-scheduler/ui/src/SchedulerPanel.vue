<script setup>
import { computed, onMounted, ref } from 'vue';

/**
 * 定时任务管理页（placement: management）。
 * 经 host.api 调用本插件的 /api/scheduler/* 管理路由；bundle 自带样式，
 * 不依赖宿主设计系统。
 */
const props = defineProps({
  pluginHost: { type: Object, default: null },
});

const api = computed(() => props.pluginHost?.api ?? null);

const tasks = ref([]);
const loading = ref(true);
const loadError = ref('');
const busyTaskId = ref('');
const dialogOpen = ref(false);
const saving = ref(false);
const formError = ref('');
const editingTaskId = ref('');
const form = ref(createEmptyForm());
const historyOpen = ref(false);
const historyTaskId = ref('');
const historyEntries = ref([]);
const historyLoading = ref(false);

function createEmptyForm() {
  return {
    task_id: '',
    cron: '0 9 * * 1-5',
    task: '',
    team: '',
    entry_agent: '',
    session_id: '',
    permission_mode: 'relaxed',
    enabled: true,
    delivery_channel: '',
    delivery_target: '',
    delivery_bot_id: '',
  };
}

async function loadTasks() {
  loading.value = true;
  loadError.value = '';
  try {
    const response = await api.value.get('/api/scheduler/');
    tasks.value = Array.isArray(response?.tasks) ? response.tasks : [];
  } catch (error) {
    loadError.value = readErrorMessage(error, '加载定时任务失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  if (!api.value) {
    loadError.value = '宿主未提供 API 上下文';
    loading.value = false;
    return;
  }
  void loadTasks();
});

function openCreate() {
  editingTaskId.value = '';
  form.value = createEmptyForm();
  formError.value = '';
  dialogOpen.value = true;
}

function openEdit(task) {
  editingTaskId.value = task.task_id;
  form.value = {
    task_id: task.task_id,
    cron: task.cron,
    task: task.task,
    team: task.team ?? '',
    entry_agent: task.entry_agent ?? '',
    session_id: task.session_id ?? '',
    permission_mode: task.permission_mode ?? 'relaxed',
    enabled: task.enabled,
    delivery_channel: task.delivery?.channel ?? '',
    delivery_target: task.delivery?.target ?? '',
    delivery_bot_id: task.delivery?.bot_id ?? '',
  };
  formError.value = '';
  dialogOpen.value = true;
}

function buildPayload() {
  const base = form.value;
  const delivery = base.delivery_channel.trim()
    ? {
      channel: base.delivery_channel.trim(),
      target: base.delivery_target.trim() || null,
      bot_id: base.delivery_bot_id.trim() || null,
    }
    : null;
  return {
    ...(editingTaskId.value ? {} : { task_id: base.task_id.trim() }),
    cron: base.cron.trim(),
    task: base.task.trim(),
    team: base.team.trim() || null,
    entry_agent: base.entry_agent.trim() || null,
    session_id: base.session_id.trim() || null,
    permission_mode: base.permission_mode,
    enabled: base.enabled,
    delivery,
  };
}

async function saveTask() {
  const payload = buildPayload();
  if (!payload.cron || !payload.task || (!editingTaskId.value && !payload.task_id)) {
    formError.value = '任务 ID、cron 表达式与任务内容为必填项';
    return;
  }
  saving.value = true;
  formError.value = '';
  try {
    if (editingTaskId.value) await api.value.put(`/api/scheduler/tasks/${encodeURIComponent(editingTaskId.value)}`, payload);
    else await api.value.post('/api/scheduler/tasks', payload);
    dialogOpen.value = false;
    await loadTasks();
  } catch (error) {
    formError.value = readErrorMessage(error, '保存任务失败');
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(task) {
  busyTaskId.value = task.task_id;
  try {
    await api.value.put(`/api/scheduler/tasks/${encodeURIComponent(task.task_id)}`, { enabled: !task.enabled });
    await loadTasks();
  } catch (error) {
    loadError.value = readErrorMessage(error, '更新任务状态失败');
  } finally {
    busyTaskId.value = '';
  }
}

async function triggerTask(task) {
  busyTaskId.value = task.task_id;
  loadError.value = '';
  try {
    const result = await api.value.post(`/api/scheduler/tasks/${encodeURIComponent(task.task_id)}/trigger`);
    await loadTasks();
    if (result?.result) window.alert(`已执行：${String(result.result).slice(0, 300)}`);
    else window.alert('已执行（无文本结果，可能挂起等待交互）');
  } catch (error) {
    window.alert(readErrorMessage(error, '执行失败'));
    await loadTasks();
  } finally {
    busyTaskId.value = '';
  }
}

async function removeTask(task) {
  if (!window.confirm(`删除定时任务“${task.task_id}”？此操作无法撤销。`)) return;
  busyTaskId.value = task.task_id;
  try {
    await api.value.del(`/api/scheduler/tasks/${encodeURIComponent(task.task_id)}`);
    await loadTasks();
  } catch (error) {
    loadError.value = readErrorMessage(error, '删除任务失败');
  } finally {
    busyTaskId.value = '';
  }
}

async function openHistory(task) {
  historyTaskId.value = task.task_id;
  historyEntries.value = [];
  historyOpen.value = true;
  historyLoading.value = true;
  try {
    const response = await api.value.get(`/api/scheduler/tasks/${encodeURIComponent(task.task_id)}/history?limit=20`);
    historyEntries.value = Array.isArray(response?.history) ? response.history : [];
  } catch (error) {
    historyEntries.value = [{ timestamp: 0, success: false, result: '', error: readErrorMessage(error, '加载历史失败'), elapsed: 0 }];
  } finally {
    historyLoading.value = false;
  }
}

async function refresh() {
  await loadTasks();
}

function formatTime(value) {
  if (!value && value !== 0) return '—';
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

function readErrorMessage(error, fallback) {
  if (!error) return fallback;
  const message = typeof error === 'string' ? error : error.message || error.error || '';
  if (typeof message === 'string' && message.trim()) {
    try {
      const parsed = JSON.parse(message);
      if (parsed?.message) return parsed.message;
    } catch { /* 非 JSON 消息原样返回 */ }
    return message;
  }
  return fallback;
}
</script>

<template>
  <div class="scheduler-panel">
    <header class="panel-header">
      <div>
        <h2>定时任务</h2>
        <p>按 cron 表达式定时驱动智能体执行；结果写入任务会话，可选投递通道通知。</p>
      </div>
      <div class="header-actions">
        <button type="button" :disabled="loading" @click="refresh">刷新</button>
        <button type="button" class="primary" @click="openCreate">新建任务</button>
      </div>
    </header>

    <p v-if="loadError" class="panel-error" role="alert">{{ loadError }}</p>

    <div v-if="loading" class="panel-empty">正在加载任务…</div>
    <div v-else-if="!tasks.length" class="panel-empty">暂无定时任务，点击「新建任务」创建。</div>
    <table v-else class="task-table">
      <thead>
        <tr>
          <th>任务</th>
          <th>cron</th>
          <th>下次执行</th>
          <th>上次结果</th>
          <th>状态</th>
          <th class="col-actions">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="task in tasks" :key="task.task_id">
          <td>
            <div class="task-name" :title="task.task">{{ task.task_id }}</div>
            <div class="task-sub" :title="task.task">{{ task.task }}</div>
          </td>
          <td><code>{{ task.cron }}</code></td>
          <td>{{ task.enabled ? formatTime(task.next_run) : '已停用' }}</td>
          <td>
            <div class="task-sub">{{ formatTime(task.last_run) }}</div>
            <div class="task-sub" :title="task.last_result">{{ task.last_result || '—' }}</div>
          </td>
          <td>
            <button type="button" class="toggle" :class="{ on: task.enabled }" :disabled="busyTaskId === task.task_id" @click="toggleEnabled(task)">
              {{ task.enabled ? '启用中' : '已停用' }}
            </button>
          </td>
          <td class="col-actions">
            <button type="button" :disabled="busyTaskId === task.task_id" @click="triggerTask(task)">执行</button>
            <button type="button" :disabled="busyTaskId === task.task_id" @click="openHistory(task)">历史</button>
            <button type="button" :disabled="busyTaskId === task.task_id" @click="openEdit(task)">编辑</button>
            <button type="button" class="danger" :disabled="busyTaskId === task.task_id" @click="removeTask(task)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="dialogOpen" class="dialog-backdrop" @click.self="dialogOpen = false">
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>{{ editingTaskId ? '编辑定时任务' : '新建定时任务' }}</h3>
        <p v-if="formError" class="panel-error" role="alert">{{ formError }}</p>
        <form @submit.prevent="saveTask">
          <label>
            <span>任务 ID</span>
            <input v-model="form.task_id" :disabled="Boolean(editingTaskId)" placeholder="如 daily-report" required />
          </label>
          <label>
            <span>cron 表达式（分 时 日 月 周）</span>
            <input v-model="form.cron" placeholder="0 9 * * 1-5" required />
          </label>
          <label>
            <span>任务内容（交给智能体执行）</span>
            <textarea v-model="form.task" rows="3" required />
          </label>
          <div class="form-grid">
            <label>
              <span>Team（可选，空为当前激活）</span>
              <input v-model="form.team" />
            </label>
            <label>
              <span>入口 Agent（可选）</span>
              <input v-model="form.entry_agent" />
            </label>
            <label>
              <span>固定会话 ID（可选）</span>
              <input v-model="form.session_id" />
            </label>
            <label>
              <span>权限模式</span>
              <select v-model="form.permission_mode">
                <option value="relaxed">relaxed</option>
                <option value="standard">standard</option>
                <option value="strict">strict</option>
              </select>
            </label>
            <label>
              <span>投递通道（可选，如 feishu）</span>
              <input v-model="form.delivery_channel" placeholder="留空表示仅写入会话" />
            </label>
            <label>
              <span>投递目标（如飞书 chat_id）</span>
              <input v-model="form.delivery_target" />
            </label>
            <label>
              <span>发送者 bot（通道用，可选）</span>
              <input v-model="form.delivery_bot_id" />
            </label>
          </div>
          <label class="checkbox-row">
            <input v-model="form.enabled" type="checkbox" />
            <span>创建后立即启用</span>
          </label>
          <div class="dialog-actions">
            <button type="button" :disabled="saving" @click="dialogOpen = false">取消</button>
            <button type="submit" class="primary" :disabled="saving">{{ saving ? '保存中…' : '保存' }}</button>
          </div>
        </form>
      </div>
    </div>

    <div v-if="historyOpen" class="dialog-backdrop" @click.self="historyOpen = false">
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>执行历史 · {{ historyTaskId }}</h3>
        <div v-if="historyLoading" class="panel-empty">正在加载…</div>
        <div v-else-if="!historyEntries.length" class="panel-empty">暂无历史（重启后进程内历史会清空，结果以任务列表的上次执行为准）</div>
        <table v-else class="task-table">
          <thead>
            <tr><th>时间</th><th>结果</th><th>耗时</th></tr>
          </thead>
          <tbody>
            <tr v-for="(entry, index) in historyEntries" :key="index">
              <td>{{ formatTime(entry.timestamp) }}</td>
              <td>
                <span :class="entry.success ? 'ok' : 'fail'">{{ entry.success ? '成功' : '失败' }}</span>
                <div class="task-sub" :title="entry.result || entry.error">{{ entry.result || entry.error || '—' }}</div>
              </td>
              <td>{{ Number(entry.elapsed ?? 0).toFixed(1) }}s</td>
            </tr>
          </tbody>
        </table>
        <div class="dialog-actions">
          <button type="button" @click="historyOpen = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scheduler-panel {
  --sp-border: #d6d3d1;
  --sp-text: #292524;
  --sp-sub: #78716c;
  --sp-surface: #ffffff;
  --sp-muted: #f5f5f4;
  color: var(--sp-text);
  font-size: 14px;
  max-width: 64rem;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
}

.panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
.panel-header h2 { margin: 0; font-size: 1.125rem; }
.panel-header p { margin: 0.25rem 0 0; color: var(--sp-sub); font-size: 0.8125rem; }
.header-actions { display: flex; gap: 0.5rem; }

button {
  border: 1px solid var(--sp-border);
  border-radius: 6px;
  background: var(--sp-surface);
  color: var(--sp-text);
  font-size: 0.8125rem;
  padding: 0.3rem 0.7rem;
  cursor: pointer;
}
button:hover:not(:disabled) { background: var(--sp-muted); }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.primary { background: #1c1917; border-color: #1c1917; color: #fff; }
button.primary:hover:not(:disabled) { background: #44403c; }
button.danger { color: #dc2626; }
button.toggle { min-width: 4rem; }
button.toggle.on { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }

.panel-empty { padding: 2.5rem 1rem; text-align: center; color: var(--sp-sub); }
.panel-error { color: #dc2626; font-size: 0.8125rem; }

.task-table { width: 100%; border-collapse: collapse; border: 1px solid var(--sp-border); border-radius: 8px; overflow: hidden; }
.task-table th, .task-table td { text-align: left; padding: 0.55rem 0.75rem; border-bottom: 1px solid #e7e5e4; vertical-align: top; }
.task-table th { background: var(--sp-muted); font-size: 0.75rem; font-weight: 600; color: var(--sp-sub); }
.task-table tbody tr:hover { background: #fafaf9; }
.task-name { font-weight: 600; }
.task-sub { color: var(--sp-sub); font-size: 0.75rem; max-width: 22rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-actions { white-space: nowrap; }
.col-actions button + button { margin-left: 0.25rem; }
code { background: var(--sp-muted); border-radius: 4px; padding: 0.1rem 0.3rem; font-size: 0.75rem; }
.ok { color: #047857; }
.fail { color: #dc2626; }

.dialog-backdrop { position: fixed; inset: 0; background: rgba(28, 25, 23, 0.4); display: grid; place-items: center; z-index: 50; }
.dialog { background: var(--sp-surface); border-radius: 12px; box-shadow: 0 20px 60px rgba(28, 25, 23, 0.2); max-width: 40rem; width: min(92vw, 40rem); max-height: 85vh; overflow: auto; padding: 1.25rem 1.5rem; }
.dialog h3 { margin: 0 0 0.75rem; font-size: 1rem; }
label { display: block; margin-bottom: 0.6rem; }
label span { display: block; font-size: 0.75rem; color: var(--sp-sub); margin-bottom: 0.2rem; }
input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid var(--sp-border); border-radius: 6px; padding: 0.4rem 0.5rem; font-size: 0.8125rem; font-family: inherit; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 0.75rem; }
.checkbox-row { display: flex; align-items: center; gap: 0.4rem; }
.checkbox-row input { width: auto; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.75rem; }
</style>
