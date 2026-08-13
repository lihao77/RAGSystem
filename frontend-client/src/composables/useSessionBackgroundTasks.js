import { computed, ref, unref, watch } from 'vue';
import {
  cancelSessionBackgroundTask,
  cancelSessionBackgroundTasks,
  getSessionBackgroundTasks,
} from '../api/backgroundTasks.js';

const RUNNING_STATUS = 'running';
const LIFECYCLE_OVERRIDE_TTL_MS = 60_000;

function responseData(response) {
  return response?.data && typeof response.data === 'object' ? response.data : response;
}

export function backgroundTaskId(task) {
  return String(task?.task_id || task?.id || '');
}

export function backgroundTaskCancelReason(task) {
  if (task?.cancel_available) return '';
  const reason = task?.cancel_unavailable_reason;
  const reasonLabels = {
    already_finished: '任务已结束',
    not_cancellable: '该任务类型不支持取消',
    not_owned: '任务由其他运行实例持有，当前实例无法取消',
    not_found: '任务不存在或已过期',
  };
  return reasonLabels[reason]
    || reason
    || (task?.cancel_supported === false ? '该任务类型不支持取消' : '')
    || (task?.status !== RUNNING_STATUS ? '任务已结束' : '当前执行实例无法取消');
}

export function useSessionBackgroundTasks(sessionId) {
  const tasks = ref([]);
  const filter = ref('running');
  const selectedTaskIds = ref([]);
  const loading = ref(false);
  const cancelling = ref(false);
  const error = ref('');
  let requestGeneration = 0;
  let actionGeneration = 0;
  const lifecycleOverrides = new Map();

  const currentSessionId = () => String(unref(sessionId) || '').trim();
  const runningTasks = computed(() => tasks.value.filter((task) => task.status === RUNNING_STATUS));
  const runningCount = computed(() => runningTasks.value.length);
  const filteredTasks = computed(() => filter.value === 'running' ? runningTasks.value : tasks.value);
  const selectedCancellableTasks = computed(() => tasks.value.filter((task) => (
    task.cancel_available === true && selectedTaskIds.value.includes(backgroundTaskId(task))
  )));

  function replaceTasks(nextTasks) {
    tasks.value = [...nextTasks].sort((left, right) => {
      if (left.status === RUNNING_STATUS && right.status !== RUNNING_STATUS) return -1;
      if (right.status === RUNNING_STATUS && left.status !== RUNNING_STATUS) return 1;
      return Number(right.started_at || 0) - Number(left.started_at || 0);
    });
    const available = new Set(tasks.value
      .filter((task) => task.cancel_available === true)
      .map(backgroundTaskId));
    selectedTaskIds.value = selectedTaskIds.value.filter((taskId) => available.has(taskId));
  }

  async function loadTasks({ silent = false } = {}) {
    const selectedSessionId = currentSessionId();
    const generation = ++requestGeneration;
    if (!selectedSessionId) {
      replaceTasks([]);
      error.value = '';
      loading.value = false;
      return [];
    }
    if (!silent) loading.value = true;
    error.value = '';
    try {
      const response = await getSessionBackgroundTasks(selectedSessionId);
      if (generation !== requestGeneration || selectedSessionId !== currentSessionId()) return tasks.value;
      const nextTasks = responseData(response)?.tasks;
      replaceTasks(reconcileServerTasks(Array.isArray(nextTasks) ? nextTasks : []));
      return tasks.value;
    } catch (cause) {
      if (generation === requestGeneration && selectedSessionId === currentSessionId()) {
        error.value = cause?.message || '后台任务加载失败';
      }
      return tasks.value;
    } finally {
      if (generation === requestGeneration && !silent) loading.value = false;
    }
  }

  function mergeTask(task) {
    const taskId = backgroundTaskId(task);
    if (!taskId) return;
    const index = tasks.value.findIndex((item) => backgroundTaskId(item) === taskId);
    if (index < 0) replaceTasks([...tasks.value, task]);
    else replaceTasks(tasks.value.map((item, itemIndex) => itemIndex === index ? { ...item, ...task } : item));
  }

  function mergeCancelResult(result) {
    const taskId = backgroundTaskId(result);
    const existing = tasks.value.find((task) => backgroundTaskId(task) === taskId);
    if (!taskId || !existing) return;
    const terminal = ['completed', 'failed', 'cancelled'].includes(result?.status);
    const patch = {
      ...result,
      ...(result?.status == null ? { status: existing.status } : {}),
      ...(result?.cancelled || terminal
        ? { cancel_available: false, cancel_unavailable_reason: 'already_finished' }
        : result?.reason
          ? { cancel_available: false, cancel_unavailable_reason: result.reason }
          : {}),
    };
    lifecycleOverrides.set(taskId, { task: { ...existing, ...patch }, updatedAt: Date.now() });
    mergeTask(patch);
  }

  function reconcileServerTasks(serverTasks) {
    const merged = new Map(serverTasks.map((task) => [backgroundTaskId(task), task]));
    const now = Date.now();
    for (const [taskId, entry] of lifecycleOverrides) {
      if (now - entry.updatedAt > LIFECYCLE_OVERRIDE_TTL_MS) {
        lifecycleOverrides.delete(taskId);
        continue;
      }
      const serverTask = merged.get(taskId);
      if (!serverTask || isLifecycleTaskNewer(entry.task, serverTask)) {
        merged.set(taskId, serverTask ? { ...serverTask, ...entry.task } : entry.task);
      } else {
        lifecycleOverrides.delete(taskId);
      }
    }
    return [...merged.values()];
  }

  function isLifecycleTaskNewer(eventTask, serverTask) {
    const eventRank = taskStatusRank(eventTask?.status);
    const serverRank = taskStatusRank(serverTask?.status);
    if (eventRank !== serverRank) return eventRank > serverRank;
    if (eventTask?.cancel_available === false && serverTask?.cancel_available === true) return true;
    const eventCompletedAt = Number(eventTask?.completed_at || 0);
    const serverCompletedAt = Number(serverTask?.completed_at || 0);
    return eventCompletedAt > serverCompletedAt;
  }

  function taskStatusRank(status) {
    return status === RUNNING_STATUS ? 0 : status ? 1 : -1;
  }

  function handleLifecycleEvent(detail) {
    if (detail?.entity !== 'background_task') return false;
    if (detail.task) {
      mergeTask(detail.task);
      const taskId = backgroundTaskId(detail.task);
      if (taskId) lifecycleOverrides.set(taskId, { task: detail.task, updatedAt: Date.now() });
    }
    return true;
  }

  function toggleTaskSelection(task) {
    if (task?.cancel_available !== true) return;
    const taskId = backgroundTaskId(task);
    if (!taskId) return;
    selectedTaskIds.value = selectedTaskIds.value.includes(taskId)
      ? selectedTaskIds.value.filter((item) => item !== taskId)
      : [...selectedTaskIds.value, taskId];
  }

  function setFilter(value) {
    filter.value = value === 'all' ? 'all' : 'running';
  }

  async function cancelTask(task) {
    if (task?.cancel_available !== true || cancelling.value) return null;
    const taskId = backgroundTaskId(task);
    const selectedSessionId = currentSessionId();
    if (!taskId || !selectedSessionId) return null;
    const generation = ++actionGeneration;
    cancelling.value = true;
    error.value = '';
    try {
      const response = await cancelSessionBackgroundTask(selectedSessionId, taskId);
      if (generation !== actionGeneration || selectedSessionId !== currentSessionId()) return null;
      const result = responseData(response)?.result;
      if (result) mergeCancelResult(result);
      await loadTasks({ silent: true });
      return result || null;
    } catch (cause) {
      if (generation === actionGeneration && selectedSessionId === currentSessionId()) {
        error.value = cause?.message || '后台任务取消失败';
      }
      return null;
    } finally {
      if (generation === actionGeneration) cancelling.value = false;
    }
  }

  async function cancelSelected() {
    const taskIds = selectedCancellableTasks.value.map(backgroundTaskId);
    const selectedSessionId = currentSessionId();
    if (!taskIds.length || cancelling.value || !selectedSessionId) return [];
    const generation = ++actionGeneration;
    cancelling.value = true;
    error.value = '';
    try {
      const response = await cancelSessionBackgroundTasks(selectedSessionId, taskIds);
      if (generation !== actionGeneration || selectedSessionId !== currentSessionId()) return [];
      const results = responseData(response)?.results;
      if (Array.isArray(results)) results.forEach(mergeCancelResult);
      selectedTaskIds.value = [];
      await loadTasks({ silent: true });
      return Array.isArray(results) ? results : [];
    } catch (cause) {
      if (generation === actionGeneration && selectedSessionId === currentSessionId()) {
        error.value = cause?.message || '后台任务批量取消失败';
      }
      return [];
    } finally {
      if (generation === actionGeneration) cancelling.value = false;
    }
  }

  watch(() => currentSessionId(), () => {
    actionGeneration += 1;
    cancelling.value = false;
    replaceTasks([]);
    lifecycleOverrides.clear();
    selectedTaskIds.value = [];
    void loadTasks();
  }, { immediate: true });

  return {
    tasks,
    filter,
    selectedTaskIds,
    loading,
    cancelling,
    error,
    runningTasks,
    runningCount,
    filteredTasks,
    selectedCancellableTasks,
    loadTasks,
    handleLifecycleEvent,
    setFilter,
    toggleTaskSelection,
    cancelTask,
    cancelSelected,
  };
}
