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
}) {
  const sessionRunStore = useSessionRunStore();
  const { currentSessionId, participantMessages } = storeToRefs(sessionRunStore);
  const execution = useMessageExecution({
    currentSessionId,
    chatSdkClient,
    activeRun,
    participantMessages,
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
