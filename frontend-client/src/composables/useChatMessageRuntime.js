import {
  createAssistantMessage,
  normalizeAssistantExecutionState,
  useMessageExecution,
} from './useMessageExecution';
import { useTaskNotifications } from './useTaskNotifications';
import { useWorkPanelSelection } from './useWorkPanelSelection';

export function useChatMessageRuntime({
  currentSessionId,
  messages,
  activeRun,
  showToast,
}) {
  const execution = useMessageExecution({
    currentSessionId,
    showToast,
  });

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
