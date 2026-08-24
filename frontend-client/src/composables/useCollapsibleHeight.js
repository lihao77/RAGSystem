import { nextTick, onScopeDispose, watch } from 'vue';

/**
 * 折叠高度动画：max-height 由实测值驱动，与调用方 CSS 配套（容器初值 max-height: 0 +
 * max-height 过渡）。不用 grid 0fr/1fr——Chrome 在 fr 过渡期对 grid item 的 stretch 解析
 * 有缺陷，容器按插值高度占位、内容不跟随，动画过程中会在内容下方留出一段空白。
 *
 * - 展开：钉 min(实测内容高, cap)，releaseDelay 后释放上限（有限 cap 回到 cap 值——流式
 *   增长仍有滚动空间；Infinity 回到 none——内容增长不被裁剪）。
 * - 收起：上限已释放时先无过渡钉回当前可视高度再收到 0——从 none/cap 值直接插值会空跑
 *   （短内容在越过自身高度前一直无视觉变化，最后一瞬收完）。
 * - 钉住期间内容长高（流式）：ResizeObserver 驱动只增不减地重设目标，平滑追赶；不重排
 *   释放定时器——连续流式若每次续期，上限会一直处在追赶过渡中，最新内容长期被裁在可视
 *   区外，初次展开排定的释放照常触发后交还给释放值。
 * - 元素出现（初始挂载 / v-if 晚挂载）时若已是展开态：立即补一次同步——折叠状态只经由
 *   这里落地到 DOM，不依赖"状态变化"的时机，挂载瞬间即正确。
 *
 * @param {import('vue').Ref<HTMLElement|null>} elRef 折叠容器（模板 ref）
 * @param {import('vue').Ref<boolean>} expanded 展开态
 * @param {{ cap?: number, releaseDelay?: number }} [options]
 */
export function useCollapsibleHeight(elRef, expanded, { cap = Infinity, releaseDelay = 260 } = {}) {
  const releaseValue = cap === Infinity ? 'none' : `${cap}px`;
  let releaseTimer = 0;
  let resizeObs = null;
  let mutationObs = null;
  let observedChildren = new Set();

  function targetHeight(el) {
    return Math.min(el.scrollHeight, cap);
  }

  /** 上限仍钉在实测值（未释放、未收起）时才允许追赶。 */
  function isPinned(el) {
    const value = el.style.maxHeight;
    return Boolean(value) && value !== '0px' && value !== 'none' && value !== releaseValue;
  }

  function retarget(el) {
    if (!expanded.value || !isPinned(el)) return;
    const target = targetHeight(el);
    if (target <= parseFloat(el.style.maxHeight)) return;
    el.style.maxHeight = `${target}px`;
  }

  function scheduleRelease(el) {
    releaseTimer = window.setTimeout(() => {
      if (expanded.value) el.style.maxHeight = releaseValue;
    }, releaseDelay);
  }

  function syncHeight(open) {
    const el = elRef.value;
    if (!el) return;
    window.clearTimeout(releaseTimer);
    if (open) {
      el.style.maxHeight = `${targetHeight(el)}px`;
      scheduleRelease(el);
      return;
    }
    if (el.style.maxHeight === 'none' || el.style.maxHeight === releaseValue) {
      el.style.transition = 'none';
      el.style.maxHeight = `${el.offsetHeight}px`;
      void el.offsetHeight;
      el.style.transition = '';
    }
    el.style.maxHeight = '0px';
  }

  function reobserveChildren(el) {
    if (!resizeObs) return;
    const nextChildren = new Set(el.children);
    for (const child of observedChildren) {
      if (!nextChildren.has(child)) resizeObs.unobserve(child);
    }
    for (const child of nextChildren) {
      if (!observedChildren.has(child)) resizeObs.observe(child);
    }
    observedChildren = nextChildren;
  }

  function observeContent(el) {
    resizeObs = new ResizeObserver(() => retarget(el));
    mutationObs = new MutationObserver(() => {
      // 子元素追加/移除（流式新节点）不改变既有子元素尺寸，RO 感知不到，childList 补上。
      reobserveChildren(el);
      retarget(el);
    });
    mutationObs.observe(el, { childList: true });
    reobserveChildren(el);
  }

  function stopObserving() {
    resizeObs?.disconnect();
    mutationObs?.disconnect();
    resizeObs = null;
    mutationObs = null;
    observedChildren = new Set();
  }

  watch(elRef, (el) => {
    stopObserving();
    if (!el) return;
    observeContent(el);
    if (expanded.value) syncHeight(true);
  }, { flush: 'post' });

  watch(expanded, (open) => {
    // v-if 门控的容器可能与展开态同拍挂载，等 DOM 落地再测量。
    nextTick(() => syncHeight(open));
  });

  onScopeDispose(() => {
    window.clearTimeout(releaseTimer);
    stopObserving();
  });
}
