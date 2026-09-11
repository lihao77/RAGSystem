import { nextTick, onScopeDispose, ref, watch } from 'vue';

/**
 * 超高气泡折叠到固定钳高（区别于 useCollapsibleHeight 的"收起到 0"面板）：
 * 内容实测高超过 clamp 时把 max-height 钉在钳值并置 clampable，由调用方渲染
 * "展开/收起"按钮；展开时以实测全高驱动 max-height 过渡，结束（releaseDelay，
 * 略长于 240ms 的 --edit-transition-duration）后释放为 none，内容再增长不裁剪。
 * 收起时若上限已释放（none），先无过渡钉回当前可视高度再收到钳值——直接从
 * none 插值会空跑过渡（见 useCollapsibleHeight 同款处理）。
 *
 * 高度判定只用 scrollHeight（钳住 + overflow:hidden 下仍报完整内容高）；元素
 * 自身尺寸变化（换行重排、内容更新）由 ResizeObserver 重新判定，贴着钳高
 * TOLERANCE 以内的内容视为不超高，避免临界值来回闪按钮。折叠态只经由这里
 * 落地到 DOM（内联 max-height），不依赖"状态变化"的时机——元素晚挂载时若已
 * 是展开态直接释放上限。
 *
 * @param {import('vue').Ref<HTMLElement|null>} elRef 折叠容器（模板 ref）
 * @param {{ clamp?: number, releaseDelay?: number }} [options] clamp 钳高 px；releaseDelay 展开过渡后释放上限的延时 ms
 * @returns {{ expanded: import('vue').Ref<boolean>, clampable: import('vue').Ref<boolean>, toggle: () => void }}
 */
export function useClampedExpand(elRef, { clamp = 280, releaseDelay = 320 } = {}) {
  const TOLERANCE = 8;
  const expanded = ref(false);
  const clampable = ref(false);
  let releaseTimer = 0;
  let resizeObs = null;

  /** 未展开时按实测内容高判定/落钳；展开态的 max-height 由 syncHeight 驱动。 */
  function measure() {
    const el = elRef.value;
    if (!el || expanded.value) return;
    const overflows = el.scrollHeight > clamp + TOLERANCE;
    clampable.value = overflows;
    el.style.maxHeight = overflows ? `${clamp}px` : '';
  }

  function syncHeight(open) {
    const el = elRef.value;
    if (!el) return;
    clearTimeout(releaseTimer);
    if (open) {
      el.style.maxHeight = `${el.scrollHeight}px`;
      releaseTimer = setTimeout(() => {
        if (expanded.value && elRef.value) elRef.value.style.maxHeight = 'none';
      }, releaseDelay);
      return;
    }
    if (el.style.maxHeight === 'none') {
      el.style.transition = 'none';
      el.style.maxHeight = `${el.offsetHeight}px`;
      void el.offsetHeight;
      el.style.transition = '';
    }
    el.style.maxHeight = `${clamp}px`;
  }

  function toggle() {
    expanded.value = !expanded.value;
  }

  watch(elRef, (el) => {
    resizeObs?.disconnect();
    resizeObs = null;
    if (!el) return;
    if (typeof ResizeObserver === 'function') {
      resizeObs = new ResizeObserver(measure);
      resizeObs.observe(el);
    }
    measure();
    // 晚挂载（v-if 切换/编辑态往返）时保持已展开：直接释放，不做进场动画。
    if (expanded.value) el.style.maxHeight = 'none';
  }, { flush: 'post' });

  watch(expanded, (open) => {
    // 展开态与元素挂载可能同拍（v-if），等 DOM 落地再测量。
    nextTick(() => syncHeight(open));
  });

  onScopeDispose(() => {
    clearTimeout(releaseTimer);
    resizeObs?.disconnect();
  });

  return { expanded, clampable, toggle };
}
