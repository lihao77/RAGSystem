import { storeToRefs } from 'pinia';
import {
  createAssistantMessage,
  normalizeAssistantExecutionState,
  useMessageExecution,
} from './useMessageExecution';
import { useTaskNotifications } from './useTaskNotifications';
import { useWorkPanelSelection } from './useWorkPanelSelection';
import { useSessionRunStore } from '../stores/session-run.js';

export function useChatMessageRuntime({
  activeRun,
  showToast,
  chatSdkClient,
  selectedParticipantId,
  selectedParticipant,
}) {
  const sessionRunStore = useSessionRunStore();
  const { currentSessionId, messages } = storeToRefs(sessionRunStore);
  const execution = useMessageExecution({
    currentSessionId,
    chatSdkClient,
    activeRun,
    selectedParticipantId,
    syncParticipantMessage: sessionRunStore.upsertParticipantMessage,
  });

  const workPanel = useWorkPanelSelection({
    messages,
    activeRun,
    hasExecutionContent: execution.hasExecutionContent,
    ensureExecutionStepsLoaded: execution.ensureExecutionStepsLoaded,
    showToast,
    selectedParticipantId,
    selectedParticipant,
    getParticipantRunExecutionMessage: execution.getParticipantRunExecutionMessage,
    getParticipantRunExecutionMessages: execution.getParticipantRunExecutionMessages,
    ensureParticipantRunsLoaded: execution.ensureParticipantRunsLoaded,
  });

  const notifications = useTaskNotifications();

  return {
    createAssistantMessage,
    normalizeAssistantExecutionState,
    ...execution,
    ...workPanel,
    ...notifications,
  };
}
