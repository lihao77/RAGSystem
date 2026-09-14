<template>
  <PageLayout title="定时任务" subtitle="个人 Cron 计划任务" mobile-title="定时任务">
    <div class="scheduler-manager">
      <div class="section-toolbar">
        <div class="toolbar-left">
          <span class="toolbar-hint">任务到点自动执行；也可手动触发并查看历史。</span>
        </div>
        <div class="toolbar-right">
          <Button variant="secondary" size="icon" :disabled="loadAction.loading.value" title="刷新" aria-label="刷新" @click="loadAction.run()">
            <RefreshCw data-icon :class="cn({ 'animate-spin': loadAction.loading.value })" />
          </Button>
          <Button size="sm" @click="openCreate">
            <IconPlus data-icon="inline-start" />
            新建任务
          </Button>
        </div>
      </div>

      <div class="data-table-wrapper glass-card">
        <div v-if="loadAction.loading.value" class="g-table-loading">
          <div class="g-skeleton-rows" aria-busy="true">
            <div v-for="n in 4" :key="n" class="g-skeleton-row">
              <div class="g-skeleton-bar g-skeleton-bar--title" />
              <div class="g-skeleton-bar g-skeleton-bar--sub" />
            </div>
          </div>
        </div>
        <EmptyState v-else-if="loadError" :title="loadError">
          <Button variant="outline" size="sm" @click="loadAction.run()">重试</Button>
        </EmptyState>
        <EmptyState v-else-if="tasks.length === 0" title="暂无定时任务">
          <Button variant="outline" size="sm" @click="openCreate">新建第一个任务</Button>
        </EmptyState>
        <Table v-else class="scheduler-table">
          <TableHeader>
            <TableRow>
              <TableHead>任务</TableHead>
              <TableHead>Cron</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>下次运行</TableHead>
              <TableHead>最近结果</TableHead>
              <TableHead class="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="task in tasks" :key="task.task_id">
              <TableCell class="task-cell">
                <div class="flex flex-col gap-1">
                  <span class="truncate font-medium" :title="task.task_id">{{ task.task_id }}</span>
                  <span class="task-summary" :title="task.task">{{ task.task || '-' }}</span>
                </div>
              </TableCell>
              <TableCell><Badge variant="outline" class="cron-badge">{{ task.cron }}</Badge></TableCell>
              <TableCell>
                <div class="status-cell">
                  <Badge :variant="task.enabled ? 'success' : 'secondary'">{{ task.enabled ? '启用' : '停用' }}</Badge>
                  <Switch
                    :checked="task.enabled"
                    :disabled="toggleBusyId === task.task_id"
                    :aria-label="`${task.enabled ? '停用' : '启用'}任务 ${task.task_id}`"
                    @update:checked="value => toggleEnabled(task, value)"
                  />
                </div>
              </TableCell>
              <TableCell class="cell-secondary">{{ formatRunTime(task.next_run) || '未计划' }}</TableCell>
              <TableCell class="cell-secondary">
                <span class="task-result" :title="task.last_result || ''">{{ resultSummary(task) }}</span>
              </TableCell>
              <TableCell class="cell-actions">
                <div class="row-actions">
                  <Button variant="action-success" size="action" title="立即触发" aria-label="立即触发" :disabled="triggerBusyId === task.task_id" @click="triggerAction.run(task.task_id)">
                    <IconPlay data-icon />
                  </Button>
                  <Button variant="action-neutral" size="action" title="运行历史" aria-label="运行历史" @click="historyAction.run(task.task_id)">
                    <History data-icon />
                  </Button>
                  <Button variant="action-neutral" size="action" title="编辑" aria-label="编辑" @click="openEdit(task)">
                    <IconEdit data-icon />
                  </Button>
                  <Button variant="action-danger" size="action" title="删除" aria-label="删除" @click="removeAction.run(task.task_id)">
                    <IconTrash data-icon />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <div v-if="!loadAction.loading.value && !loadError && tasks.length > 0" class="table-footer">
          <span>共 {{ tasks.length }} 个任务</span>
        </div>
      </div>
    </div>

    <Dialog v-model:open="editDialogOpen">
      <DialogContent class="max-w-[620px]">
        <DialogHeader>
          <DialogTitle>{{ editingTaskId ? '编辑定时任务' : '新建定时任务' }}</DialogTitle>
          <DialogDescription>标准五段 Cron 表达式（分 时 日 月 周）；保存后按计划自动执行。</DialogDescription>
        </DialogHeader>
        <div class="dialog-form form-grid">
          <div class="form-item">
            <label for="scheduler-task-id">任务 ID</label>
            <Input id="scheduler-task-id" v-model="form.task_id" :disabled="Boolean(editingTaskId)" placeholder="例如 daily-report" />
          </div>
          <div class="form-item">
            <label for="scheduler-cron">Cron</label>
            <Input id="scheduler-cron" v-model="form.cron" class="input-mono" placeholder="0 9 * * 1-5" />
          </div>
          <div class="form-item full">
            <label for="scheduler-task">任务内容</label>
            <Textarea id="scheduler-task" v-model="form.task" rows="4" placeholder="到点交给 Agent 执行的任务描述" />
          </div>
          <div class="form-item">
            <label>团队 / 入口 Agent</label>
            <TeamAgentSelector
              :team="form.team"
              :team-options="teamOptions"
              :team-loading="teamLoading"
              :entry-agent="form.entry_agent"
              variant="field"
              side="bottom"
              allow-default
              @update:selection="onTeamAgentSelection"
            />
          </div>
          <div class="form-item">
            <label>权限模式</label>
            <CustomSelect v-model="form.permission_mode" :options="permissionModeOptions" />
          </div>
          <div class="form-item">
            <label for="scheduler-session">固定会话（可选）</label>
            <Input id="scheduler-session" v-model="form.session_id" placeholder="留空按任务派生固定会话" />
          </div>
          <div class="form-item">
            <label>投递通道（可选）</label>
            <CustomSelect v-model="form.delivery_channel" :options="deliveryChannelOptions" />
          </div>
          <template v-if="form.delivery_channel">
            <div class="form-item">
              <label for="scheduler-target">投递目标 chat_id</label>
              <Input id="scheduler-target" v-model="form.delivery_target" placeholder="例如飞书会话 ID" />
            </div>
            <div class="form-item">
              <label for="scheduler-bot">投递 Bot（可选）</label>
              <Input id="scheduler-bot" v-model="form.delivery_bot_id" placeholder="留空自动选择可用机器人" />
            </div>
          </template>
          <div class="form-item full">
            <label>启用任务</label>
            <Switch v-model:checked="form.enabled" aria-label="启用任务" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="editDialogOpen = false">取消</Button>
          <Button :disabled="saveAction.loading.value" @click="saveAction.run()">保存任务</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="historyDialogOpen">
      <DialogContent class="max-w-[680px]">
        <DialogHeader>
          <DialogTitle>运行历史</DialogTitle>
          <DialogDescription>{{ historyTaskId }}</DialogDescription>
        </DialogHeader>
        <EmptyState v-if="historyRows.length === 0" title="暂无运行记录" />
        <Table v-else class="history-table">
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>耗时</TableHead>
              <TableHead>结果 / 错误</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="(row, index) in historyRows" :key="index">
              <TableCell class="cell-secondary">{{ formatRunTime(row.timestamp) }}</TableCell>
              <TableCell>
                <Badge :variant="row.success ? 'success' : 'destructive'">{{ row.success ? '成功' : '失败' }}</Badge>
              </TableCell>
              <TableCell class="cell-secondary">{{ row.elapsed != null ? `${Number(row.elapsed).toFixed(1)}s` : '-' }}</TableCell>
              <TableCell class="cell-secondary">
                <span class="task-result" :title="row.error || row.result || ''">{{ row.error || row.result || '-' }}</span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </DialogContent>
    </Dialog>
  </PageLayout>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { History, RefreshCw } from 'lucide-vue-next';
import PageLayout from '../components/PageLayout.vue';
import EmptyState from '../components/EmptyState.vue';
import CustomSelect from '../components/ui/CustomSelect.vue';
import TeamAgentSelector from '../components/chat/TeamAgentSelector.vue';
import IconEdit from '../components/icons/IconEdit.vue';
import IconPlay from '../components/icons/IconPlay.vue';
import IconPlus from '../components/icons/IconPlus.vue';
import IconTrash from '../components/icons/IconTrash.vue';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Textarea } from '../components/ui/textarea';
import * as schedulerApi from '../api/scheduler.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { useConfirm } from '../composables/useConfirm.js';
import { useToast } from '../composables/useToast.js';
import { useDictionariesStore } from '../stores/dictionaries.js';
import { cn } from '../lib/utils.ts';

const toast = useToast();
const { confirm } = useConfirm();
const dictStore = useDictionariesStore();

const tasks = ref([]);
const teamOptions = ref([]);
const teamLoading = ref(false);
const activeTeam = ref('');
const loadError = ref('');
const editDialogOpen = ref(false);
const historyDialogOpen = ref(false);
const editingTaskId = ref('');
const historyTaskId = ref('');
const historyRows = ref([]);
const toggleBusyId = ref('');
const triggerBusyId = ref('');

const form = reactive(createEmptyForm());

const permissionModeOptions = [
  { value: 'standard', label: '标准（中高风险需审批）' },
  { value: 'relaxed', label: '宽松（自动化推荐）' },
  { value: 'dangerously_skip_permissions', label: '跳过审批（高风险）' },
];
const deliveryChannelOptions = [
  { value: '', label: '不投递（结果留在会话）' },
  { value: 'feishu', label: '飞书' },
];

function createEmptyForm() {
  return {
    task_id: '', cron: '0 9 * * 1-5', task: '', team: '', entry_agent: '', permission_mode: 'relaxed',
    session_id: '', delivery_channel: '', delivery_target: '', delivery_bot_id: '', enabled: true,
  };
}

const loadAction = useAsyncAction(async () => {
  try {
    tasks.value = await schedulerApi.listSchedulerTasks();
    loadError.value = '';
  } catch (error) {
    loadError.value = error?.message || '加载定时任务失败';
  }
});

const loadTeams = async () => {
  teamLoading.value = true;
  try {
    const result = await dictStore.ensureTeams();
    const teams = Array.isArray(result?.teams) ? result.teams : [];
    activeTeam.value = result?.active_team || '';
    teamOptions.value = teams.map(team => {
      const isActive = team.team_name === activeTeam.value;
      return {
        value: team.team_name,
        label: isActive ? `${team.team_name}（默认）` : team.team_name,
        isActive,
      };
    });
  } catch (error) {
    console.warn('加载 Team 列表失败:', error);
    teamOptions.value = [];
  } finally {
    teamLoading.value = false;
  }
};

const saveAction = useAsyncAction(async () => {
  if (!form.task_id.trim() || !form.cron.trim() || !form.task.trim()) {
    throw new Error('请填写任务 ID、Cron 表达式与任务内容');
  }
  const payload = buildPayload();
  if (editingTaskId.value) await schedulerApi.updateSchedulerTask(editingTaskId.value, payload);
  else await schedulerApi.createSchedulerTask({ task_id: form.task_id.trim(), ...payload });
  editDialogOpen.value = false;
  await loadAction.run();
}, { successMessage: '定时任务已保存', errorPrefix: '保存定时任务失败' });

const removeAction = useAsyncAction(async taskId => {
  const ok = await confirm({
    message: `删除任务 ${taskId}？计划执行将立即停止，此操作不可撤销。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  await schedulerApi.deleteSchedulerTask(taskId);
  await loadAction.run();
}, { successMessage: '定时任务已删除', errorPrefix: '删除定时任务失败' });

const triggerAction = useAsyncAction(async taskId => {
  triggerBusyId.value = taskId;
  try {
    await schedulerApi.triggerSchedulerTask(taskId);
    await loadAction.run();
  } finally {
    triggerBusyId.value = '';
  }
}, { successMessage: '任务已触发', errorPrefix: '触发失败' });

const historyAction = useAsyncAction(async taskId => {
  const result = await schedulerApi.getSchedulerTaskHistory(taskId, 20);
  historyTaskId.value = taskId;
  historyRows.value = Array.isArray(result?.history) ? result.history : [];
  historyDialogOpen.value = true;
}, { errorPrefix: '加载运行历史失败' });

async function toggleEnabled(task, value) {
  toggleBusyId.value = task.task_id;
  try {
    await schedulerApi.updateSchedulerTask(task.task_id, { enabled: Boolean(value) });
    await loadAction.run();
    toast.success(value ? '任务已启用' : '任务已停用');
  } catch (error) {
    toast.error(error?.message || '更新任务状态失败');
  } finally {
    toggleBusyId.value = '';
  }
}

function openCreate() {
  editingTaskId.value = '';
  Object.assign(form, createEmptyForm(), { team: activeTeam.value || '' });
  editDialogOpen.value = true;
}

function openEdit(task) {
  editingTaskId.value = task.task_id;
  Object.assign(form, createEmptyForm(), {
    task_id: task.task_id,
    cron: task.cron,
    task: task.task,
    team: task.team || '',
    entry_agent: task.entry_agent || '',
    permission_mode: task.permission_mode || 'relaxed',
    session_id: task.session_id || '',
    delivery_channel: task.delivery?.channel || '',
    delivery_target: task.delivery?.target || '',
    delivery_bot_id: task.delivery?.bot_id || '',
    enabled: Boolean(task.enabled),
  });
  editDialogOpen.value = true;
}

function buildPayload() {
  const delivery = form.delivery_channel
    ? {
      channel: form.delivery_channel,
      target: form.delivery_target.trim() || null,
      bot_id: form.delivery_bot_id.trim() || null,
    }
    : null;
  return {
    cron: form.cron.trim(),
    task: form.task.trim(),
    team: form.team.trim() || null,
    entry_agent: form.entry_agent || null,
    permission_mode: form.permission_mode || 'relaxed',
    session_id: form.session_id.trim() || null,
    delivery,
    enabled: Boolean(form.enabled),
  };
}

function onTeamAgentSelection({ team, entryAgent }) {
  form.team = team || '';
  form.entry_agent = entryAgent || '';
}

function resultSummary(task) {
  if (!task.last_run) return '暂无';
  return task.last_result || '-';
}

function formatRunTime(unixSeconds) {
  if (!unixSeconds) return '';
  return new Date(unixSeconds * 1000).toLocaleString();
}

onMounted(() => {
  void loadAction.run();
  void loadTeams();
});
</script>

<style scoped>
.scheduler-manager { display: flex; flex-direction: column; gap: var(--spacing-md); }
.section-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); }
.toolbar-right { display: flex; align-items: center; gap: var(--spacing-sm); }
.toolbar-hint { color: var(--color-text-muted); font-size: var(--font-size-sm); }
.data-table-wrapper { border-radius: var(--radius-lg); border: 1px solid var(--color-border); background: var(--color-bg-secondary); overflow: hidden; }
.scheduler-table :deep(tbody td) { vertical-align: middle; }
.cell-secondary { color: var(--color-text-secondary); }
.cell-actions { text-align: right; }
.row-actions { display: flex; justify-content: flex-end; flex-wrap: nowrap; gap: var(--spacing-xs); }
.table-footer { display: flex; align-items: center; justify-content: space-between; padding: var(--spacing-sm) var(--spacing-md); border-top: 1px solid var(--color-border); color: var(--color-text-muted); font-size: var(--font-size-xs); }
.status-cell { display: flex; align-items: center; gap: var(--spacing-sm); }
.task-cell { max-width: 320px; }
.task-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); font-size: var(--font-size-sm); }
.task-result { display: inline-block; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cron-badge { font-family: var(--font-mono); }
.dialog-form.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }
.form-item { display: flex; flex-direction: column; gap: var(--spacing-xs); min-width: 0; }
.form-item.full { grid-column: 1 / -1; }
.form-item label { color: var(--color-text-secondary); font-size: var(--font-size-sm); font-weight: 600; }
.input-mono { font-family: var(--font-mono); }
@media (max-width: 720px) {
  .section-toolbar { flex-direction: column; align-items: stretch; gap: var(--spacing-sm); }
  .toolbar-right { width: 100%; min-width: 0; flex-wrap: wrap; justify-content: flex-end; gap: var(--spacing-xs); }
  .dialog-form.form-grid { grid-template-columns: 1fr; }
  .form-item.full { grid-column: auto; }
}
</style>
