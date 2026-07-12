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
        <img
          v-if="current"
          :src="current.src"
          :alt="current.alt || ''"
          class="image-lightbox__image"
          :style="{ transform: `scale(${scale}) rotate(${rotation}deg)` }"
          draggable="false"
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
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
        </button>
        <button
          v-if="images.length > 1"
          class="image-lightbox__nav image-lightbox__nav--next"
          aria-label="下一张"
          @click="emit('next')"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
        </button>

        <div v-if="current" class="image-lightbox__toolbar">
          <button class="image-lightbox__toolbtn" aria-label="缩小" @click="zoom(-0.2)">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
          <span class="image-lightbox__zoom">{{ Math.round(scale * 100) }}%</span>
          <button class="image-lightbox__toolbtn" aria-label="放大" @click="zoom(0.2)">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
          <span class="image-lightbox__sep" />
          <button class="image-lightbox__toolbtn" aria-label="旋转" @click="rotation += 90">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
          </button>
          <button class="image-lightbox__toolbtn" aria-label="重置" @click="reset">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v6h6" /><path d="M3 9a9 9 0 1 1 2.12 6.36" /></svg>
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import IconClose from '../icons/IconClose.vue';

const props = defineProps({
  open: Boolean,
  images: { type: Array, default: () => [] },
  index: { type: Number, default: 0 },
  current: { type: Object, default: null },
});
const emit = defineEmits(['close', 'previous', 'next']);

const scale = ref(1);
const rotation = ref(0);
const reset = () => { scale.value = 1; rotation.value = 0; };
const zoom = (delta) => { scale.value = Math.min(5, Math.max(0.2, scale.value + delta)); };
const onWheel = (event) => zoom(event.deltaY > 0 ? -0.15 : 0.15);
const onKey = (event) => {
  if (!props.open) return;
  if (event.key === 'Escape') emit('close');
  if (event.key === 'ArrowLeft') emit('previous');
  if (event.key === 'ArrowRight') emit('next');
};
watch(() => props.index, reset);
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
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
