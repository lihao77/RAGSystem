import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';

const SCROLL_DETACH_THRESHOLD = 120;
const SCROLL_REATTACH_THRESHOLD = 80;
// 用户向上滚后停下：即使未达阈值也暂停跟随，避免流式把阅读中的用户拉回底部
const PAUSE_DELAY = 600;

export function useChatScrolling(deps) {
  const messagesRef = ref(null);
  const isFollowing = ref(true);
  const scrollBottomGap = ref(0);
  const unreadCount = ref(0);

  let isProgrammaticScroll = false;
  let lastScrollTop = 0;
  let userScrollUpAccum = 0;
  let pauseTimer = null;
  let lastMsgCount = deps.messages.value.length;

  // --- 内容高度变化自动跟随（双 Observer） ---
  let mutationObs = null;
  let resizeObs = null;
  let observedChild = null;
  let lastObsScrollHeight = 0;   // Observer 用的高度基线
  let lastObsClientHeight = 0;   // 滚动区自身高度变化（如底部输入区变高）
  let lastHandleHeight = 0;      // handleScroll 用的高度基线（独立，避免竞态）
  let pendingRaf = null;

  /** rAF 去抖：内容高度变化时，若 isFollowing 则滚到底 */
  const scheduleFollowScroll = () => {
    if (pendingRaf) return;
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = null;
      const container = messagesRef.value;
      if (!container) return;
      const h = container.scrollHeight;
      const clientHeight = container.clientHeight;
      const geometryChanged = h !== lastObsScrollHeight || clientHeight !== lastObsClientHeight;
      if (geometryChanged && isFollowing.value) {
        isProgrammaticScroll = true;
        scrollContainerTo(container, h, 'auto');
        lastScrollTop = container.scrollTop;
        updateScrollBottomGap();
      }
      lastObsScrollHeight = h;
      lastObsClientHeight = clientHeight;
    });
  };

  /** 对滚动容器的直接子元素挂 ResizeObserver */
  const reobserveChild = (container) => {
    if (observedChild && resizeObs) resizeObs.unobserve(observedChild);
    observedChild = container.firstElementChild;
    if (observedChild && resizeObs) resizeObs.observe(observedChild);
  };

  const cleanupObservers = () => {
    if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = null; }
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
    if (mutationObs) { mutationObs.disconnect(); mutationObs = null; }
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; observedChild = null; }
  };

  watch(messagesRef, (el) => {
    cleanupObservers();
    if (!el) return;
    lastObsScrollHeight = el.scrollHeight;
    lastObsClientHeight = el.clientHeight;
    lastHandleHeight = el.scrollHeight;

    // MutationObserver：捕获 DOM 树变化（组件挂载、异步组件替换等）
    mutationObs = new MutationObserver((mutations) => {
      // 直接子元素变化时，重新挂 ResizeObserver
      for (const m of mutations) {
        if (m.target === el && m.type === 'childList') {
          reobserveChild(el);
          break;
        }
      }
      scheduleFollowScroll();
    });
    mutationObs.observe(el, { childList: true, subtree: true });

    // ResizeObserver：捕获尺寸变化（ECharts canvas resize、图片加载、CSS 过渡等）
    resizeObs = new ResizeObserver(scheduleFollowScroll);
    resizeObs.observe(el);
    reobserveChild(el);
  });

  onScopeDispose(cleanupObservers);

  // --- 基础滚动工具 ---

  const showScrollToBottomButton = computed(() => {
    if (!deps.messages.value.length) return false;
    return !isFollowing.value;
  });

  const checkIfAtBottom = () => {
    if (!messagesRef.value) return true;
    const container = messagesRef.value;
    return container.scrollHeight - container.scrollTop - container.clientHeight < SCROLL_REATTACH_THRESHOLD;
  };

  const updateScrollBottomGap = () => {
    if (!messagesRef.value) {
      scrollBottomGap.value = 0;
      return;
    }
    const container = messagesRef.value;
    scrollBottomGap.value = Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
  };

  const waitForScrollLayout = async () => {
    await nextTick();
    await new Promise(resolve => requestAnimationFrame(() => resolve()));
  };

  const scrollContainerTo = (container, top, behavior) => {
    if (behavior === 'smooth') {
      container.scrollTo({ top, behavior: 'smooth' });
      return;
    }
    const prev = container.style.scrollBehavior;
    container.style.scrollBehavior = 'auto';
    container.scrollTop = top;
    if (prev) {
      container.style.scrollBehavior = prev;
    } else {
      container.style.removeProperty('scroll-behavior');
    }
  };

  const scrollToBottom = async (force = false, behavior = 'auto') => {
    await waitForScrollLayout();
    if (!messagesRef.value) return;
    if (force || isFollowing.value) {
      const container = messagesRef.value;
      isProgrammaticScroll = true;
      scrollContainerTo(container, container.scrollHeight, behavior);
      lastScrollTop = container.scrollTop;
      lastObsScrollHeight = container.scrollHeight;
      lastObsClientHeight = container.clientHeight;
      lastHandleHeight = container.scrollHeight;
      updateScrollBottomGap();
    }
  };

  const resetFollowing = () => {
    userScrollUpAccum = 0;
    isFollowing.value = true;
  };

  const resetScrollPosition = (follow = true) => {
    userScrollUpAccum = 0;
    isFollowing.value = follow;
    isProgrammaticScroll = false;
    lastScrollTop = 0;
    lastObsScrollHeight = 0;
    lastObsClientHeight = 0;
    lastHandleHeight = 0;
    scrollBottomGap.value = 0;
    unreadCount.value = 0;
    lastMsgCount = deps.messages.value.length;
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
    deps.topControlsBarScrolled.value = false;
    if (messagesRef.value) {
      messagesRef.value.scrollTop = 0;
    }
  };

  const stickToBottom = (behavior = 'auto') => {
    resetFollowing();
    scrollToBottom(true, behavior);
  };

  // --- 核心：区分用户滚动 vs 内容高度变化导致的 scrollTop 钳位 ---
  const handleScroll = () => {
    const container = messagesRef.value;
    if (!container) return;

    updateScrollBottomGap();

    const currentTop = container.scrollTop;
    const currentHeight = container.scrollHeight;
    const delta = currentTop - lastScrollTop;
    // 内容高度变化 → scrollTop 被浏览器钳位，不是用户操作
    const heightChanged = currentHeight !== lastHandleHeight;

    lastScrollTop = currentTop;
    lastHandleHeight = currentHeight;
    deps.topControlsBarScrolled.value = currentTop > 0;

    if (isProgrammaticScroll) {
      userScrollUpAccum = 0;
      if (checkIfAtBottom()) {
        isProgrammaticScroll = false;
      }
      return;
    }

    // 内容驱动的滚动：不累积、不脱离
    if (heightChanged) {
      userScrollUpAccum = 0;
      return;
    }

    // 真正的用户滚动
    if (delta < 0) {
      userScrollUpAccum += Math.abs(delta);
      if (userScrollUpAccum >= SCROLL_DETACH_THRESHOLD) {
        isFollowing.value = false;
      }
      // 用户向上滚后停下：即使未达阈值也暂停跟随，避免流式把阅读中的用户拉回底部
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        pauseTimer = null;
        if (!checkIfAtBottom()) isFollowing.value = false;
      }, PAUSE_DELAY);
    } else if (delta > 0 && !isFollowing.value && checkIfAtBottom()) {
      userScrollUpAccum = 0;
      isFollowing.value = true;
    }
  };

  const onScrollToBottomClick = () => {
    stickToBottom('smooth');
  };

  // 未读计数：暂停跟随时新消息累加，恢复跟随（回到底部）清零
  watch(() => deps.messages.value.length, (newLen) => {
    if (lastMsgCount > 0 && newLen > lastMsgCount && !isFollowing.value) {
      unreadCount.value += newLen - lastMsgCount;
    }
    lastMsgCount = newLen;
  });
  watch(isFollowing, (v) => { if (v) unreadCount.value = 0; });

  return {
    messagesRef,
    isFollowing,
    scrollBottomGap,
    unreadCount,
    showScrollToBottomButton,
    updateScrollBottomGap,
    waitForScrollLayout,
    scrollToBottom,
    resetFollowing,
    resetScrollPosition,
    stickToBottom,
    handleScroll,
    onScrollToBottomClick,
  };
}
