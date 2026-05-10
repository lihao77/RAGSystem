import { computed, nextTick, ref } from 'vue';

const SCROLL_DETACH_THRESHOLD = 120;
const SCROLL_REATTACH_THRESHOLD = 80;

export function useChatScrolling(deps) {
  const messagesRef = ref(null);
  const isFollowing = ref(true);
  const scrollBottomGap = ref(0);

  let isProgrammaticScroll = false;
  let lastScrollTop = 0;
  let userScrollUpAccum = 0;

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

  const scrollToBottom = async (force = false, behavior = 'auto') => {
    await waitForScrollLayout();
    if (!messagesRef.value) return;
    if (force || isFollowing.value) {
      const container = messagesRef.value;
      isProgrammaticScroll = true;
      if (behavior === 'smooth') {
        container.scrollTo({
          top: container.scrollHeight,
          behavior: 'smooth',
        });
      } else {
        container.scrollTop = container.scrollHeight;
      }
      lastScrollTop = container.scrollTop;
      updateScrollBottomGap();
    }
  };

  const resetFollowing = () => {
    userScrollUpAccum = 0;
    isFollowing.value = true;
  };

  const stickToBottom = (behavior = 'auto') => {
    resetFollowing();
    scrollToBottom(true, behavior);
  };

  const handleScroll = () => {
    const container = messagesRef.value;
    if (!container) return;

    updateScrollBottomGap();

    const currentTop = container.scrollTop;
    const delta = currentTop - lastScrollTop;
    const atBottom = checkIfAtBottom();

    if (isProgrammaticScroll) {
      lastScrollTop = currentTop;
      userScrollUpAccum = 0;
      if (atBottom) {
        isProgrammaticScroll = false;
      }
    } else {
      if (delta < 0) {
        userScrollUpAccum += Math.abs(delta);
        if (userScrollUpAccum >= SCROLL_DETACH_THRESHOLD) {
          isFollowing.value = false;
        }
      } else if (delta > 0 && !isFollowing.value && atBottom) {
        userScrollUpAccum = 0;
        isFollowing.value = true;
      }
      lastScrollTop = currentTop;
    }

    deps.topControlsBarScrolled.value = container.scrollTop > 0;
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
    stickToBottom,
    handleScroll,
    onScrollToBottomClick,
  };
}
