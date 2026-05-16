import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';

const SCROLL_DETACH_THRESHOLD = 120;
const SCROLL_REATTACH_THRESHOLD = 80;

export function useChatScrolling(deps) {
  const messagesRef = ref(null);
  const isFollowing = ref(true);
  const scrollBottomGap = ref(0);

  let isProgrammaticScroll = false;
  let lastScrollTop = 0;
  let userScrollUpAccum = 0;

  // --- 内容高度变化自动跟随（双 Observer） ---
  let mutationObs = null;
  let resizeObs = null;
  let observedChild = null;
  let lastObsScrollHeight = 0;   // Observer 用的高度基线
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
      if (h !== lastObsScrollHeight && isFollowing.value) {
        isProgrammaticScroll = true;
        scrollContainerTo(container, h, 'auto');
        lastScrollTop = container.scrollTop;
        updateScrollBottomGap();
      }
      lastObsScrollHeight = h;
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
    if (mutationObs) { mutationObs.disconnect(); mutationObs = null; }
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; observedChild = null; }
  };

  watch(messagesRef, (el) => {
    cleanupObservers();
    if (!el) return;
    lastObsScrollHeight = el.scrollHeight;
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
      lastHandleHeight = container.scrollHeight;
      updateScrollBottomGap();
    }
  };

  const resetFollowing = () => {
    userScrollUpAccum = 0;
    isFollowing.value = true;
  };

  const resetScrollPosition = () => {
    userScrollUpAccum = 0;
    isFollowing.value = true;
    isProgrammaticScroll = false;
    lastScrollTop = 0;
    lastObsScrollHeight = 0;
    lastHandleHeight = 0;
    scrollBottomGap.value = 0;
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
    } else if (delta > 0 && !isFollowing.value && checkIfAtBottom()) {
      userScrollUpAccum = 0;
      isFollowing.value = true;
    }
  };

  const onScrollToBottomClick = () => {
    stickToBottom('smooth');
  };

  return {
    messagesRef,
    isFollowing,
    scrollBottomGap,
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
