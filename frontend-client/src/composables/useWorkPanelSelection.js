import { computed, ref, watch } from 'vue';

export function useWorkPanelSelection(deps) {
  const selectedWorkPanelMessageKey = ref('');
  const selectedByUser = ref(false);

  const getWorkPanelMessageKey = (msg) => {
    if (!msg) return '';
    if (msg.id) return `id:${msg.id}`;
    if (msg.seq != null) return `seq:${msg.seq}`;
    return `idx:${deps.messages.value.indexOf(msg)}`;
  };

  const workPanelExecutionMessages = computed(() => deps.messages.value
    .map((msg, index) => ({ msg, index }))
    .filter(({ msg }) => deps.hasExecutionContent(msg))
    .map(({ msg, index }) => ({
      key: getWorkPanelMessageKey(msg),
      index,
      message: msg,
    })));

  const activeWorkPanelRunMessage = computed(() => {
    if (deps.activeRun.assistantMsgIndex < 0) return null;
    return deps.messages.value[deps.activeRun.assistantMsgIndex] ?? null;
  });

  const activeWorkPanelRunMessageKey = computed(() => getWorkPanelMessageKey(activeWorkPanelRunMessage.value));

  const currentRunMessage = computed(() => {
    const selected = workPanelExecutionMessages.value.find(item => item.key === selectedWorkPanelMessageKey.value)?.message;
    if (selectedByUser.value && selected) return selected;
    if (deps.activeRun.active) {
      return activeWorkPanelRunMessage.value;
    }
    if (selected) return selected;
    return workPanelExecutionMessages.value.at(-1)?.message || null;
  });

  const currentRunMessageKey = computed(() => getWorkPanelMessageKey(currentRunMessage.value));

  watch(currentRunMessage, (msg) => {
    if (!deps.activeRun.active && msg?.has_execution && !msg.executionStepsLoaded) {
      deps.ensureExecutionStepsLoaded(msg).catch(() => {
        deps.showToast(msg.executionStepsLoadError || '加载执行过程失败');
      });
    }
  });

  watch(workPanelExecutionMessages, (items) => {
    const selectedExists = selectedWorkPanelMessageKey.value && items.some(item => item.key === selectedWorkPanelMessageKey.value);
    if (deps.activeRun.active) {
      if (selectedByUser.value && selectedExists) return;
      selectedByUser.value = false;
      const activeRunKey = activeWorkPanelRunMessageKey.value;
      if (activeRunKey && items.some(item => item.key === activeRunKey)) {
        selectedWorkPanelMessageKey.value = activeRunKey;
      }
      return;
    }
    const latestKey = items.at(-1)?.key || '';
    const activeRunKey = activeWorkPanelRunMessageKey.value;
    if (selectedByUser.value && selectedExists) {
      return;
    }
    if (activeRunKey && items.some(item => item.key === activeRunKey)) {
      selectedByUser.value = false;
      selectedWorkPanelMessageKey.value = activeRunKey;
      return;
    }
    if (selectedExists) {
      return;
    }
    selectedByUser.value = false;
    selectedWorkPanelMessageKey.value = latestKey;
  }, { immediate: true });

  watch(() => deps.activeRun.active, (active, wasActive) => {
    const activeRunKey = activeWorkPanelRunMessageKey.value;
    if (active) {
      selectedByUser.value = false;
      if (activeRunKey && workPanelExecutionMessages.value.some(item => item.key === activeRunKey)) {
        selectedWorkPanelMessageKey.value = activeRunKey;
      }
      return;
    }
    if (wasActive && !active) {
      if (
        selectedByUser.value
        && selectedWorkPanelMessageKey.value
        && workPanelExecutionMessages.value.some(item => item.key === selectedWorkPanelMessageKey.value)
      ) {
        return;
      }
      selectedByUser.value = false;
      selectedWorkPanelMessageKey.value = workPanelExecutionMessages.value.at(-1)?.key || '';
    }
  });

  async function selectWorkPanelMessage(msgOrKey) {
    const key = typeof msgOrKey === 'string' ? msgOrKey : getWorkPanelMessageKey(msgOrKey);
    selectedWorkPanelMessageKey.value = key || '';
    selectedByUser.value = Boolean(key);
    const msg = typeof msgOrKey === 'string'
      ? workPanelExecutionMessages.value.find(item => item.key === key)?.message
      : msgOrKey;
    if (msg?.has_execution && !msg.executionStepsLoaded) {
      try {
        await deps.ensureExecutionStepsLoaded(msg);
      } catch (_) {
        deps.showToast(msg.executionStepsLoadError || '加载执行过程失败');
      }
    }
  }

  return {
    selectedWorkPanelMessageKey,
    getWorkPanelMessageKey,
    workPanelExecutionMessages,
    currentRunMessage,
    currentRunMessageKey,
    selectWorkPanelMessage,
  };
}
