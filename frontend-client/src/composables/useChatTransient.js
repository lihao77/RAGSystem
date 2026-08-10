import { ref } from 'vue';

// 聊天页瞬态动效状态:new-chat 启动切换 + 会话滚动初始恢复。
// 从 ChatViewV2 抽出,计时器与计数器在此集中管理,view 只消费状态与少量动作。
export function useChatTransient() {
  const newChatLaunching = ref(false);
  const switchingToNewChat = ref(false);
  const restoringSessionScroll = ref(false);

  let newChatLaunchTimer = null;
  let sessionScrollRestoreTimer = null;
  let pendingSessionScrollRestores = 0;

  const clearNewChatLaunchTimer = () => {
    if (!newChatLaunchTimer) return;
    window.clearTimeout(newChatLaunchTimer);
    newChatLaunchTimer = null;
  };

  const finishNewChatLaunchSoon = (delay = 680) => {
    clearNewChatLaunchTimer();
    newChatLaunchTimer = window.setTimeout(() => {
      newChatLaunching.value = false;
      newChatLaunchTimer = null;
    }, delay);
  };

  const beginNewChatLaunch = () => {
    clearNewChatLaunchTimer();
    newChatLaunching.value = true;
  };

  const cancelNewChatLaunch = () => {
    clearNewChatLaunchTimer();
    newChatLaunching.value = false;
  };

  // 进入空白会话:先置 switching,双 rAF 后解除(配合 CSS 过渡)。
  const startSwitchToNewChat = () => {
    cancelNewChatLaunch();
    switchingToNewChat.value = true;
  };

  const finishSwitchToNewChat = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        switchingToNewChat.value = false;
      });
    });
  };

  const clearSessionScrollRestoreTimer = () => {
    if (!sessionScrollRestoreTimer) return;
    window.clearTimeout(sessionScrollRestoreTimer);
    sessionScrollRestoreTimer = null;
  };

  const beginInitialScrollRestore = () => {
    clearSessionScrollRestoreTimer();
    pendingSessionScrollRestores += 1;
    restoringSessionScroll.value = true;
  };

  const endInitialScrollRestore = () => {
    pendingSessionScrollRestores = Math.max(0, pendingSessionScrollRestores - 1);
    if (pendingSessionScrollRestores > 0) return;
    clearSessionScrollRestoreTimer();
    sessionScrollRestoreTimer = window.setTimeout(() => {
      restoringSessionScroll.value = false;
      sessionScrollRestoreTimer = null;
    }, 0);
  };

  const resetChatTransient = () => {
    clearNewChatLaunchTimer();
    clearSessionScrollRestoreTimer();
    pendingSessionScrollRestores = 0;
    newChatLaunching.value = false;
    switchingToNewChat.value = false;
    restoringSessionScroll.value = false;
  };

  return {
    newChatLaunching,
    switchingToNewChat,
    restoringSessionScroll,
    beginNewChatLaunch,
    finishNewChatLaunchSoon,
    cancelNewChatLaunch,
    startSwitchToNewChat,
    finishSwitchToNewChat,
    beginInitialScrollRestore,
    endInitialScrollRestore,
    resetChatTransient,
  };
}
