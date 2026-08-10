import { storeToRefs } from 'pinia';
import {
  createAssistantMessage,
  normalizeAssistantExecutionState,
  useMessageExecution,
} from './useMessageExecution';
import { useTaskNotifications } from './useTaskNotifications';
import { useSessionRunStore } from '../stores/session-run.js';

export function useChatMessageRuntime({
  activeRun,
  chatSdkClient,
  selectedParticipantId,
}) {
  const sessionRunStore = useSessionRunStore();
  const { currentSessionId } = storeToRefs(sessionRunStore);
  const execution = useMessageExecution({
    currentSessionId,
    chatSdkClient,
    activeRun,
    selectedParticipantId,
    syncParticipantMessage: sessionRunStore.upsertParticipantMessage,
  });

  const notifications = useTaskNotifications();

  return {
    createAssistantMessage,
    normalizeAssistantExecutionState,
    ...execution,
    ...notifications,
  };
}
