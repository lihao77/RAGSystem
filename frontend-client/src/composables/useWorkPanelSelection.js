import { computed, ref, watch } from 'vue';

export function useWorkPanelSelection(deps) {
  const selectedWorkPanelMessageKey = ref('');
  const selectedByUser = ref(false);

  const getWorkPanelMessageKey = (msg) => {
    if (!msg) return '';
    if (msg.id) return `id:${msg.id}`;
    if (msg.executionParticipantId && (msg.run_id || msg.metadata?.run_id)) {
      return `participant:${msg.executionParticipantId}:run:${msg.run_id || msg.metadata.run_id}`;
    }
    if (msg.seq != null) return `seq:${msg.seq}`;
    return `idx:${deps.messages.value.indexOf(msg)}`;
  };

  const participantRunMessages = computed(() => {
    const participant = deps.selectedParticipant?.value;
    const items = deps.getParticipantRunExecutionMessages?.(participant);
    if (Array.isArray(items)) return items;
    const latest = deps.getParticipantRunExecutionMessage?.(participant) || null;
    return latest ? [latest] : [];
  });

  const workPanelExecutionMessages = computed(() => {
    const items = deps.messages.value
    .map((msg, index) => ({ msg, index }))
    .filter(({ msg }) => deps.hasExecutionContent(msg))
    .map(({ msg, index }) => ({
      key: getWorkPanelMessageKey(msg),
      index,
      message: msg,
    }));
    for (const anchor of participantRunMessages.value) {
      const anchorRunId = anchor?.run_id || anchor?.metadata?.run_id;
      if (anchor && !items.some(item => (
        item.message?.run_id || item.message?.metadata?.run_id
      ) === anchorRunId)) {
        items.push({ key: getWorkPanelMessageKey(anchor), index: -1, message: anchor });
      }
    }
    return items;
  });

  watch(() => deps.selectedParticipant?.value, (participant) => {
    if (!participant || participant.participant_id === 'root') return;
    deps.ensureParticipantRunsLoaded?.(participant)?.catch?.((error) => {
      deps.showToast(error?.message || '加载 Run 列表失败');
    });
  }, { immediate: true });

  const activeRunApplies = computed(() => (
    (!deps.selectedParticipantId || deps.selectedParticipantId.value === 'root')
    && deps.activeRun.active
  ));

  const activeWorkPanelRunMessage = computed(() => {
    if (deps.selectedParticipantId?.value && deps.selectedParticipantId.value !== 'root') return null;
    if (deps.activeRun.assistantMsgIndex < 0) return null;
    return deps.messages.value[deps.activeRun.assistantMsgIndex] ?? null;
  });

  const activeWorkPanelRunMessageKey = computed(() => getWorkPanelMessageKey(activeWorkPanelRunMessage.value));

  const currentRunMessage = computed(() => {
    const selected = workPanelExecutionMessages.value.find(item => item.key === selectedWorkPanelMessageKey.value)?.message;
    if (selectedByUser.value && selected) return selected;
    if (activeRunApplies.value) {
      return activeWorkPanelRunMessage.value;
    }
    if (selected) return selected;
    return workPanelExecutionMessages.value.at(-1)?.message || null;
  });

  watch(currentRunMessage, (msg) => {
    if (!activeRunApplies.value && msg?.has_execution && !msg.executionStepsLoaded) {
      deps.ensureExecutionStepsLoaded(msg).catch(() => {
        deps.showToast(msg.executionStepsLoadError || '加载执行过程失败');
      });
    }
  }, { immediate: true });

  watch(workPanelExecutionMessages, (items) => {
    const selectedExists = selectedWorkPanelMessageKey.value && items.some(item => item.key === selectedWorkPanelMessageKey.value);
    if (activeRunApplies.value) {
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

  watch(activeRunApplies, (active, wasActive) => {
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
    if (typeof msgOrKey !== 'string' && msgOrKey?.role !== 'assistant') return;
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
    selectWorkPanelMessage,
  };
}
