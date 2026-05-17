import { computed, onMounted, onUnmounted, ref, unref } from 'vue';

const DROPDOWN_OFFSET = 8;
const VIEWPORT_PADDING = 12;

let sharedCanvas;

function measureTextWidth(text, font) {
  if (typeof document === 'undefined') return String(text ?? '').length * 8;
  sharedCanvas ||= document.createElement('canvas');
  const ctx = sharedCanvas.getContext('2d');
  if (!ctx) return String(text ?? '').length * 8;
  ctx.font = font;
  return ctx.measureText(String(text ?? '')).width;
}

/**
 * 计算下拉菜单基于内容的最小宽度。
 * widthChrome = padding + gap + check-icon + scrollbar 等非文字占位。
 */
function getContentWidth(dropdownEl, labels, widthChrome, fallbackFont) {
  const labelEl = dropdownEl?.querySelector('.option-label');
  const font = labelEl ? window.getComputedStyle(labelEl).font : fallbackFont;
  const maxTextWidth = labels.reduce(
    (max, label) => Math.max(max, measureTextWidth(label, font)),
    0,
  );
  return Math.ceil(maxTextWidth + widthChrome);
}

/**
 * 可复用的下拉定位 composable，处理 Teleport + fixed 定位场景。
 *
 * @param {Object} options
 * @param {import('vue').Ref} options.triggerRef    - 触发元素 ref
 * @param {import('vue').Ref} options.dropdownRef   - 下拉容器 ref
 * @param {import('vue').Ref} [options.contentRef]  - 内容/滚动区域 ref（用于 scrollHeight 测量）
 * @param {import('vue').Ref<boolean>} options.isOpen - 是否展开
 * @param {number|import('vue').Ref<number>} [options.maxHeight=260]  - 最大高度
 * @param {string|import('vue').Ref<string>} [options.placement='auto'] - 'auto'|'up'|'down'
 * @param {number} [options.minWidth=0]             - 最小宽度
 * @param {number} [options.widthChrome=64]         - 非文字占位宽度（padding+icon+gap+scrollbar）
 * @param {() => string[]} [options.getLabels]      - 返回所有选项文字的 getter
 * @param {string} [options.fallbackFont='500 13px sans-serif'] - 无法读取 DOM 字体时的回退
 */
export function useDropdownPosition({
  triggerRef,
  dropdownRef,
  contentRef,
  isOpen,
  maxHeight: maxHeightOption = 260,
  placement: placementOption = 'auto',
  minWidth = 0,
  widthChrome = 64,
  getLabels,
  fallbackFont = '500 13px sans-serif',
} = {}) {
  const resolvedPlacement = ref('down');
  const dropdownPosition = ref({
    top: 0,
    left: 0,
    width: minWidth || 0,
    maxHeight: unref(maxHeightOption),
  });

  const dropdownStyle = computed(() => ({
    top: `${dropdownPosition.value.top}px`,
    left: `${dropdownPosition.value.left}px`,
    width: `${dropdownPosition.value.width}px`,
    maxHeight: `${dropdownPosition.value.maxHeight}px`,
  }));

  const dropdownTransitionName = computed(() => (
    resolvedPlacement.value === 'up' ? 'dropdown-up' : 'dropdown-down'
  ));

  const updatePosition = () => {
    const trigger = unref(triggerRef);
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const maxH = unref(maxHeightOption);
    const content = unref(contentRef);
    const dropdown = unref(dropdownRef);
    const desiredHeight = Math.min(
      maxH,
      content?.scrollHeight ?? dropdown?.scrollHeight ?? maxH,
    );
    const vpMax = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2);
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - DROPDOWN_OFFSET - VIEWPORT_PADDING);
    const spaceAbove = Math.max(0, rect.top - DROPDOWN_OFFSET - VIEWPORT_PADDING);

    let p = unref(placementOption);
    if (p === 'auto') {
      p = spaceBelow >= desiredHeight || spaceBelow >= spaceAbove ? 'down' : 'up';
    }
    resolvedPlacement.value = p;

    const availableHeight = p === 'up' ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(
      0,
      Math.min(maxH, vpMax, availableHeight || vpMax),
    );
    const renderedHeight = Math.min(desiredHeight, maxHeight);
    const unclampedTop = p === 'up'
      ? rect.top - renderedHeight - DROPDOWN_OFFSET
      : rect.bottom + DROPDOWN_OFFSET;
    const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - renderedHeight - VIEWPORT_PADDING);

    const labels = typeof getLabels === 'function' ? getLabels() : [];
    const contentW = labels.length
      ? getContentWidth(unref(dropdownRef), labels, widthChrome, fallbackFont)
      : 0;
    const width = Math.min(
      Math.max(rect.width, minWidth || 0, contentW),
      Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2),
    );
    const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);

    dropdownPosition.value = {
      top: Math.min(Math.max(unclampedTop, VIEWPORT_PADDING), maxTop),
      left: Math.min(Math.max(rect.left, VIEWPORT_PADDING), maxLeft),
      width,
      maxHeight,
    };
  };

  const onWindowChange = () => {
    if (unref(isOpen)) updatePosition();
  };

  onMounted(() => {
    window.addEventListener('resize', onWindowChange);
    window.addEventListener('scroll', onWindowChange, true);
  });

  onUnmounted(() => {
    window.removeEventListener('resize', onWindowChange);
    window.removeEventListener('scroll', onWindowChange, true);
  });

  return {
    resolvedPlacement,
    dropdownPosition,
    dropdownStyle,
    dropdownTransitionName,
    updatePosition,
  };
}
