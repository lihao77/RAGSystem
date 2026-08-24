import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';

// scroll 事件兜底：拖滚动条/键盘回到底部（gap≈0）时恢复吸附
const REATTACH_AT_BOTTOM_PX = 4;
// 滚轮/触摸向下且已接近底部：预判恢复吸附（不必精确滚到底）
const NEAR_BOTTOM_PX = 80;

export function useChatScrolling(deps) {
  const messagesRef = ref(null);
  const isFollowing = ref(true);
  const scrollBottomGap = ref(0);
  const unreadCount = ref(0);

  let isProgrammaticScroll = false;
  let lastScrollTop = 0;
  let lastTouchY = null;
  let lastMsgCount = deps.messages.value.length;

  // --- 内容高度变化自动跟随（双 Observer） ---
  let mutationObs = null;
  let resizeObs = null;
  let observedChildren = new Set();
  let lastObsScrollHeight = 0;   // Observer 用的高度基线
  let lastObsClientHeight = 0;   // 滚动区自身高度变化（如底部输入区变高）
  let lastHandleHeight = 0;      // handleScroll 用的高度基线
  let pendingRaf = null;

  const bottomGap = (container) => Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
  const isScrollable = (container) => container.scrollHeight > container.clientHeight + 1;

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
      // handleScroll 的高度基线随 observer 同步收紧：流式增长后用户紧接着的滚动
      // 事件才不会被"高度变了=内容钳位"误判吞掉。
      lastHandleHeight = h;
    });
  };

  /** 对滚动容器的所有直接子元素挂 ResizeObserver，包括消息区和底部交互区。 */
  const reobserveChildren = (container) => {
    if (!resizeObs) return;
    const nextChildren = new Set(container.children);
    for (const child of observedChildren) {
      if (!nextChildren.has(child)) resizeObs.unobserve(child);
    }
    for (const child of nextChildren) {
      if (!observedChildren.has(child)) resizeObs.observe(child);
    }
    observedChildren = nextChildren;
  };

  /* --- 吸附状态机 ---
     脱离：用户"向上"的输入意图（wheel/touchmove）立即脱离——不累积、不等暂停；
           拖滚动条/键盘上滚由 handleScroll 里 delta<0 兜底。
     恢复：wheel/touchmove 向下且接近底部预判恢复；真正到底（gap≈0）由 scroll 事件恢复。
     嵌套滚动区（思考块/详情文本/代码块）消费的滚动不触碰外层吸附态。 */

  /** 事件是否会被嵌套滚动区消费（该方向还能滚）：是则与外层吸附无关。 */
  const nestedScrollerConsumes = (event, dir) => {
    const container = messagesRef.value;
    let node = event.target;
    while (node && node !== container) {
      if (node.nodeType === 1) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) {
          const canUp = node.scrollTop > 1;
          const canDown = node.scrollHeight - node.scrollTop - node.clientHeight > 1;
          if ((dir === 'up' && canUp) || (dir === 'down' && canDown)) return true;
        }
      }
      node = node.parentElement;
    }
    return false;
  };

  const applyScrollIntent = (dir, event) => {
    const container = messagesRef.value;
    if (!container || !isScrollable(container)) return;
    if (nestedScrollerConsumes(event, dir)) return;
    if (dir === 'up') {
      isFollowing.value = false;
    } else if (!isFollowing.value && bottomGap(container) < NEAR_BOTTOM_PX) {
      isFollowing.value = true;
    }
  };

  const handleWheelIntent = (event) => {
    if (event.deltaY < 0) applyScrollIntent('up', event);
    else if (event.deltaY > 0) applyScrollIntent('down', event);
  };

  const handleTouchStart = (event) => {
    lastTouchY = event.touches[0]?.clientY ?? null;
  };

  const handleTouchMove = (event) => {
    const y = event.touches[0]?.clientY;
    if (y == null) return;
    const prev = lastTouchY;
    lastTouchY = y;
    if (prev == null) return;
    // 手指下滑（dy>0）= 内容上滚
    const dy = y - prev;
    if (Math.abs(dy) < 2) return;
    applyScrollIntent(dy > 0 ? 'up' : 'down', event);
  };

  let intentEl = null;
  const detachIntentListeners = () => {
    if (!intentEl) return;
    intentEl.removeEventListener('wheel', handleWheelIntent);
    intentEl.removeEventListener('touchstart', handleTouchStart);
    intentEl.removeEventListener('touchmove', handleTouchMove);
    intentEl = null;
  };

  const cleanupObservers = () => {
    if (pendingRaf) { cancelAnimationFrame(pendingRaf); pendingRaf = null; }
    if (mutationObs) { mutationObs.disconnect(); mutationObs = null; }
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; observedChildren = new Set(); }
    detachIntentListeners();
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
          reobserveChildren(el);
          break;
        }
      }
      scheduleFollowScroll();
    });
    mutationObs.observe(el, { childList: true, subtree: true });

    // ResizeObserver：捕获尺寸变化（ECharts canvas resize、图片加载、CSS 过渡等）
    resizeObs = new ResizeObserver(scheduleFollowScroll);
    resizeObs.observe(el);
    reobserveChildren(el);

    // 输入意图监听（passive：不拦截滚动本身）
    el.addEventListener('wheel', handleWheelIntent, { passive: true });
    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: true });
    intentEl = el;
  });

  onScopeDispose(cleanupObservers);

  // --- 基础滚动工具 ---

  const showScrollToBottomButton = computed(() => {
    if (!deps.messages.value.length) return false;
    return !isFollowing.value;
  });

  const updateScrollBottomGap = () => {
    if (!messagesRef.value) {
      scrollBottomGap.value = 0;
      return;
    }
    scrollBottomGap.value = bottomGap(messagesRef.value);
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
    isFollowing.value = true;
  };

  const resetScrollPosition = (follow = true) => {
    isFollowing.value = follow;
    isProgrammaticScroll = false;
    lastScrollTop = 0;
    lastTouchY = null;
    lastObsScrollHeight = 0;
    lastObsClientHeight = 0;
    lastHandleHeight = 0;
    scrollBottomGap.value = 0;
    unreadCount.value = 0;
    lastMsgCount = deps.messages.value.length;
    deps.topControlsBarScrolled.value = false;
    if (messagesRef.value) {
      messagesRef.value.scrollTop = 0;
    }
  };

  const stickToBottom = (behavior = 'auto') => {
    resetFollowing();
    scrollToBottom(true, behavior);
  };

  /* scroll 事件兜底：wheel/touchmove 意图已覆盖绝大多数路径，这里只兜拖滚动条/键盘。
     高度变化的钳位事件不算用户操作（基线已被 observer rAF 收紧，误判窗口限在帧内）。 */
  const handleScroll = () => {
    const container = messagesRef.value;
    if (!container) return;

    updateScrollBottomGap();

    const currentTop = container.scrollTop;
    const currentHeight = container.scrollHeight;
    const delta = currentTop - lastScrollTop;
    const heightChanged = currentHeight !== lastHandleHeight;

    lastScrollTop = currentTop;
    lastHandleHeight = currentHeight;
    deps.topControlsBarScrolled.value = currentTop > 0;

    if (isProgrammaticScroll) {
      isProgrammaticScroll = false;
      return;
    }
    if (heightChanged) return;

    // 向下且到底：恢复吸附（含程序滚动落底、拖滚动条到底）
    if (delta > 0 && bottomGap(container) <= REATTACH_AT_BOTTOM_PX) {
      isFollowing.value = true;
      return;
    }
    // 向上：立即脱离（wheel 已即时脱离的用户再触发一次也无害）
    if (delta < 0) {
      isFollowing.value = false;
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
