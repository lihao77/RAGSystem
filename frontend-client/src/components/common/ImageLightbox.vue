<template>
  <Teleport to="body">
    <Transition name="lightbox-fade">
      <div
        v-if="open"
        class="image-lightbox"
        tabindex="-1"
        @click.self="emit('close')"
        @wheel.prevent="onWheel"
      >
        <AuthenticatedImage
          v-if="current"
          ref="imageRef"
          :src="current.src"
          :alt="current.alt || ''"
          class="image-lightbox__image"
          :class="{ 'image-lightbox__image--dragging': dragging }"
          :style="{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotation}deg)` }"
          draggable="false"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        />

        <div v-if="current" class="image-lightbox__topbar">
          <div class="image-lightbox__meta">
            <span v-if="current.alt" class="image-lightbox__title" :title="current.alt">{{ current.alt }}</span>
            <span v-if="images.length > 1" class="image-lightbox__count">{{ index + 1 }} / {{ images.length }}</span>
          </div>
          <button class="image-lightbox__iconbtn image-lightbox__close" aria-label="关闭预览" @click="emit('close')">
            <IconClose :size="18" />
          </button>
        </div>

        <button
          v-if="images.length > 1"
          class="image-lightbox__nav image-lightbox__nav--prev"
          aria-label="上一张"
          @click="emit('previous')"
        >
          <IconChevronLeft :size="22" />
        </button>
        <button
          v-if="images.length > 1"
          class="image-lightbox__nav image-lightbox__nav--next"
          aria-label="下一张"
          @click="emit('next')"
        >
          <IconChevronRight :size="22" />
        </button>

        <div v-if="current" class="image-lightbox__toolbar">
          <button class="image-lightbox__toolbtn" aria-label="缩小" title="缩小" @click="zoom(-0.2)">
            <Minus :size="18" />
          </button>
          <span class="image-lightbox__zoom">{{ Math.round(scale * 100) }}%</span>
          <button class="image-lightbox__toolbtn" aria-label="放大" title="放大" @click="zoom(0.2)">
            <Plus :size="18" />
          </button>
          <span class="image-lightbox__sep" />
          <button class="image-lightbox__toolbtn" aria-label="旋转" title="旋转" @click="rotation += 90">
            <RotateCw :size="18" />
          </button>
          <button class="image-lightbox__toolbtn" aria-label="重置视图" title="重置视图" @click="reset">
            <IconExpand :size="18" />
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import IconClose from '../icons/IconClose.vue';
import IconExpand from '../icons/IconExpand.vue';
import IconChevronLeft from '../icons/IconChevronLeft.vue';
import IconChevronRight from '../icons/IconChevronRight.vue';
import { Minus, Plus, RotateCw } from 'lucide-vue-next';
import AuthenticatedImage from './AuthenticatedImage.vue';

const props = defineProps({
  open: Boolean,
  images: { type: Array, default: () => [] },
  index: { type: Number, default: 0 },
  current: { type: Object, default: null },
});
const emit = defineEmits(['close', 'previous', 'next']);

const scale = ref(1);
const rotation = ref(0);
const offset = ref({ x: 0, y: 0 });
const dragging = ref(false);
const imageRef = ref(null);

// 布局尺寸（offsetWidth/Height 不受 transform 影响），旋转 90°/270° 时宽高互换
function imageHalfExtents() {
  const el = imageRef.value?.$el;
  if (!el?.offsetWidth) return null;
  const swap = rotation.value % 180 !== 0;
  return {
    x: ((swap ? el.offsetHeight : el.offsetWidth) * scale.value) / 2,
    y: ((swap ? el.offsetWidth : el.offsetHeight) * scale.value) / 2,
  };
}

const EDGE_MARGIN = 48;
// 图片边缘与视口至少保留 EDGE_MARGIN 重叠的宽松界：小图约等于中心不出视口，
// 放大后的大图则允许中心远出视口（边角内容也看得到），只保证图片不会彻底消失
function panLimit() {
  const half = imageHalfExtents() || { x: 0, y: 0 };
  return {
    x: Math.max(0, half.x + window.innerWidth / 2 - EDGE_MARGIN),
    y: Math.max(0, half.y + window.innerHeight / 2 - EDGE_MARGIN),
  };
}
const reset = () => {
  scale.value = 1;
  rotation.value = 0;
  offset.value = { x: 0, y: 0 };
};
// 以 (clientX, clientY) 为锚点缩放：变换为 translate + scale + rotate，
// 锚点换算 t1 = (1-k)c + k·t0（k 为新旧缩放比，c 为锚点相对视口中心的向量），
// 旋转矩阵在推导中可交换消去，公式与 rotation 无关。
// 放大缩小同一套锚点逻辑，不夹"盖满视口/居中"——图片允许偏心、允许露边，
// 光标下的点任何一步都钉死。锚点本身夹进当前图片矩形：光标在图外时贴到
// 最近边缘，小图放大不会被甩出视口。
// 棘轮保底：偏移最多推到 max(panLimit, 缩放前位置)——正常锚点缩放碰不到
// 这条界，只在图片快滑出视口时冻结进一步外漂，绝不往回拽。
const zoomAt = (clientX, clientY, delta) => {
  const next = Math.min(5, Math.max(0.2, scale.value + delta));
  if (next === scale.value) return;
  const k = next / scale.value;
  const half = imageHalfExtents() || { x: 0, y: 0 };
  const clamp = (value, limit) => Math.min(limit, Math.max(-limit, value));
  const anchorX = offset.value.x + clamp(clientX - window.innerWidth / 2 - offset.value.x, half.x);
  const anchorY = offset.value.y + clamp(clientY - window.innerHeight / 2 - offset.value.y, half.y);
  const prevX = offset.value.x;
  const prevY = offset.value.y;
  scale.value = next;
  const limit = panLimit();
  const limitX = Math.max(limit.x, Math.abs(prevX));
  const limitY = Math.max(limit.y, Math.abs(prevY));
  offset.value = {
    x: clamp((1 - k) * anchorX + k * prevX, limitX),
    y: clamp((1 - k) * anchorY + k * prevY, limitY),
  };
};
// 工具栏按钮以图片当前中心为锚点：原地缩放，不牵动已有偏移；
// 缩小时若图片已被推得很偏，原地纯缩放会让它彻底离开视口，
// 收拢回保底界内（有 0.18s transform 过渡，是平滑滑动不是跳变）
const zoom = (delta) => {
  zoomAt(window.innerWidth / 2 + offset.value.x, window.innerHeight / 2 + offset.value.y, delta);
  if (delta < 0) {
    const limit = panLimit();
    offset.value = {
      x: Math.min(limit.x, Math.max(-limit.x, offset.value.x)),
      y: Math.min(limit.y, Math.max(-limit.y, offset.value.y)),
    };
  }
};
const onWheel = (event) => zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? -0.15 : 0.15);

// 拖拽平移：只允许左键，任何缩放状态下都可拖，完全跟手。
// 不强制盖满视口或居中；唯一保底是 panLimit（图片与视口至少保留一条边可见），
// 且上限以拖拽起点的偏移起底——即便缩放把图片推得很偏，起手也不会往回拽造成跳动
const drag = { pointerId: null, startX: 0, startY: 0, originX: 0, originY: 0 };
const onPointerDown = (event) => {
  if (event.button !== 0) return;
  drag.pointerId = event.pointerId;
  drag.startX = event.clientX;
  drag.startY = event.clientY;
  drag.originX = offset.value.x;
  drag.originY = offset.value.y;
  dragging.value = true;
  event.currentTarget.setPointerCapture(event.pointerId);
};
const onPointerMove = (event) => {
  if (!dragging.value || event.pointerId !== drag.pointerId) return;
  const limit = panLimit();
  const limitX = Math.max(limit.x, Math.abs(drag.originX));
  const limitY = Math.max(limit.y, Math.abs(drag.originY));
  offset.value = {
    x: Math.min(limitX, Math.max(-limitX, drag.originX + event.clientX - drag.startX)),
    y: Math.min(limitY, Math.max(-limitY, drag.originY + event.clientY - drag.startY)),
  };
};
const onPointerUp = (event) => {
  if (event.pointerId !== drag.pointerId) return;
  dragging.value = false;
  drag.pointerId = null;
};

const onKey = (event) => {
  if (!props.open) return;
  if (event.key === 'Escape') emit('close');
  if (event.key === 'ArrowLeft') emit('previous');
  if (event.key === 'ArrowRight') emit('next');
};
// 视口变小后最多把图片拢回保底界内，其余情况不动偏移
const onResize = () => {
  const limit = panLimit();
  offset.value = {
    x: Math.min(limit.x, Math.max(-limit.x, offset.value.x)),
    y: Math.min(limit.y, Math.max(-limit.y, offset.value.y)),
  };
};
watch(() => props.index, reset);
watch(() => props.open, (open) => {
  if (!open) { dragging.value = false; drag.pointerId = null; }
});
onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', onResize);
});
</script>

<style scoped>
.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.92);
  backdrop-filter: blur(6px);
  overflow: hidden;
}

.image-lightbox__image {
  max-width: 88vw;
  max-height: 82vh;
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
  transition: transform 0.18s ease;
  user-select: none;
  -webkit-user-drag: none;
  touch-action: none;
  cursor: grab;
}
/* 拖动跟随需要关闭 transform 过渡 */
.image-lightbox__image--dragging {
  transition: none;
  cursor: grabbing;
}

/* 顶栏：标题/计数（左）+ 关闭（右），底部渐变遮罩保证白字可读 */
.image-lightbox__topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 22px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.55), transparent);
  pointer-events: none;
}
.image-lightbox__meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.image-lightbox__title {
  color: rgba(255, 255, 255, 0.92);
  font-size: 13px;
  font-weight: 500;
  max-width: 60vw;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.image-lightbox__count {
  color: rgba(255, 255, 255, 0.55);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.image-lightbox__close { pointer-events: auto; flex-shrink: 0; }

/* 玻璃质感图标按钮（通用） */
.image-lightbox__iconbtn,
.image-lightbox__nav,
.image-lightbox__toolbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.85);
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
}
.image-lightbox__iconbtn:hover,
.image-lightbox__nav:hover,
.image-lightbox__toolbtn:hover {
  background: rgba(255, 255, 255, 0.18);
  color: #fff;
}
.image-lightbox__iconbtn:active,
.image-lightbox__nav:active,
.image-lightbox__toolbtn:active {
  transform: scale(0.94);
}

.image-lightbox__iconbtn {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  backdrop-filter: blur(12px);
}

/* 左右导航：大圆形 */
.image-lightbox__nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 48px;
  height: 48px;
  border-radius: 50%;
  backdrop-filter: blur(12px);
}
.image-lightbox__nav--prev { left: 24px; }
.image-lightbox__nav--next { right: 24px; }

/* 底部胶囊工具栏 */
.image-lightbox__toolbar {
  position: absolute;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 10px;
  background: rgba(28, 28, 30, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  backdrop-filter: blur(16px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}
.image-lightbox__toolbtn {
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: transparent;
}
.image-lightbox__toolbtn:hover {
  background: rgba(255, 255, 255, 0.14);
  border-color: transparent;
}
.image-lightbox__zoom {
  color: rgba(255, 255, 255, 0.8);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  min-width: 46px;
  text-align: center;
}
.image-lightbox__sep {
  width: 1px;
  height: 18px;
  margin: 0 6px;
  background: rgba(255, 255, 255, 0.14);
}

/* 淡入淡出 */
.lightbox-fade-enter-active,
.lightbox-fade-leave-active {
  transition: opacity 0.2s ease;
}
.lightbox-fade-enter-from,
.lightbox-fade-leave-to {
  opacity: 0;
}

@media (max-width: 640px) {
  .image-lightbox__nav { width: 40px; height: 40px; }
  .image-lightbox__nav--prev { left: 12px; }
  .image-lightbox__nav--next { right: 12px; }
}
</style>
