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
}) {
  const { currentSessionId, messages } = storeToRefs(useSessionRunStore());
  const execution = useMessageExecution({ currentSessionId, chatSdkClient, activeRun });

  const workPanel = useWorkPanelSelection({
    messages,
    activeRun,
    hasExecutionContent: execution.hasExecutionContent,
    ensureExecutionStepsLoaded: execution.ensureExecutionStepsLoaded,
    showToast,
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
