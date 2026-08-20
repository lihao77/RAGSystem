<template>
  <div v-if="catalog" ref="rootRef" class="pet-root" :data-corner="corner" :style="rootStyle">
    <div class="pet-stage" :style="stageStyle">
      <canvas ref="canvasRef" class="pet-canvas" width="640" height="360" title="桌宠" />
      <video ref="videoARef" class="pet-video" muted playsinline />
      <video ref="videoBRef" class="pet-video" muted playsinline />
      <div
        class="pet-hit"
        :class="{ dragging: isDragging }"
        :style="hitStyle"
        title="桌宠"
        @click="onClick"
        @dblclick="onDoubleClick"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerenter="onHitEnter"
        @pointerleave="onHitLeave"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />
    </div>
    <!-- 状态气泡：挂在 pet-root 内，拖拽/漫游时随根元素一起移动 -->
    <Transition name="pet-notice">
      <div v-if="notice" class="pet-notice" :class="notice.kind" role="status">
        <svg class="pet-notice-icon" viewBox="0 0 14 14" aria-hidden="true">
          <path v-if="notice.kind === 'done'" class="stroke" d="M2.5 7.5l3 3 6-7" />
          <path v-else-if="notice.kind === 'error'" class="stroke" d="M3.5 3.5l7 7M10.5 3.5l-7 7" />
          <circle v-else class="fill" cx="7" cy="7" r="2.6" />
        </svg>
        <span>{{ notice.text }}</span>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import {
  DRAG_THRESHOLD,
  HIT_BOX,
  IDLE,
  MOVE_TAIL_SEC,
  buildCatalog,
  feetBottomPad,
  moveProgressRatio,
  pick,
  pickNext,
  TURN,
} from './petChain.js';

/**
 * 桌宠本体：双缓冲 webm 播放 + 概率动画链 + 点击/拖拽/漫游 + agent 状态联动。
 * 移植自 dsh-pet（MIT）lib/client.js，渲染层重写为 canvas 合成：
 *
 * - 两个隐藏 <video> 负责解码，可见 <canvas> 每帧绘制（640×360 原生分辨率）。
 * - 切换动画时旧视频先 pause（冻结帧、alpha=1）垫底，新视频以缓动 alpha 叠加淡入——
 *   相比两个 video 元素的 CSS 交叉淡入（过渡瞬间双方半透明、人物“透底”），
 *   合成淡入保证任意时刻整体不透明，消除切换痕迹。
 * - 每个视频槽位记忆自己的朝向（镜像在绘制时按槽位应用），淡出帧保持原朝向。
 * - 以递增“代数”gen 丢弃过期就绪回调，防止快速连点把画面切丢。
 * - 链式模型：所有动画一次性播放，ended 按概率选下一个（30/10/40/20）；
 *   mood=busy（agent 运行中）时改走工作动画池；error/done 脉冲一次性打断。
 */
const emit = defineEmits(['quick-ask']);

const props = defineProps({
  /** 舞台宽度（px），高 = 宽 × 9/16。 */
  size: { type: Number, default: 462 },
  corner: { type: String, default: 'bottom-right' },
  assetBase: { type: String, default: '/api/pet/thumb' },
  /** 后端 manifest 的可用动画名；null = 假定全套素材齐全。 */
  available: { type: Array, default: null },
  /** 初始动画名（场景配置 default_animation）；素材清单里没有时回退待机。 */
  initialAnim: { type: String, default: null },
  /** idle | busy：busy 时优先工作动画（写代码/思考…），不转向不漫游。 */
  mood: { type: String, default: 'idle' },
  /** 一次性脉冲：{ kind: 'error' | 'done', at }——at 变化即触发一次打断动画。 */
  pulse: { type: Object, default: null },
  /** busy 期间的工具映射提示 { anim, at }：agent 正在用什么 → 宠物演什么。 */
  hint: { type: Object, default: null },
  /** 显示器索引（多显示器时每窗一个），位置记忆按其分键。 */
  display: { type: [String, Number], default: '0' },
  /** 头顶状态药丸 { kind: 'idle'|'done'|'error'|'info', text }；null = 隐藏。 */
  notice: { type: Object, default: null },
});

const catalog = computed(() => buildCatalog(props.available));

// ---- 响应式状态 ----
// 初始动画取场景配置 default_animation；不在素材清单（含假定齐全）内时回退待机
const resolveInitialAnim = () => {
  const wanted = props.initialAnim?.trim();
  if (!wanted) return IDLE;
  const c = catalog.value;
  return [c.idle, ...c.acts, ...c.busy, ...c.done, ...c.clicks].includes(wanted) ? wanted : IDLE;
};
const anim = ref(resolveInitialAnim());
const once = ref(true);
const facing = ref('left');
const isDragging = ref(false);
/** 自定义位置（拖拽/漫游后停留的视口比例）；null = 走 data-corner 默认角落。 */
const customPos = ref(null);
/** 播放序号：同名动画连续选中时强制重播。 */
const seq = ref(0);
const viewport = ref({ w: 0, h: 0 });

const rootRef = ref(null);
const canvasRef = ref(null);
const videoARef = ref(null);
const videoBRef = ref(null);

// ---- 非响应式内部状态（高频路径，避免触发渲染） ----
let front = 0; // 当前显示的视频槽位：0=A，1=B
const facingBySlot = ['left', 'left']; // 各槽位自己的朝向（淡出帧保持原朝向）
let pending = null; // 加载中的 { anim, once, gen }
let gen = 0; // 切换代数（过期回调丢弃）
let transition = null; // { start } 合成淡入进行中；null = 稳态
let rafId = null; // 渲染循环 rAF id
let ctx2d = null;
let dragState = { active: false, dragging: false, sx: 0, sy: 0, offX: 0, offY: 0 };
let justDragged = false;
let moveRaf = null;
let moveToken = 0;
let pendingMove = null; // 计划中的移动（等移动动画就绪后由 rAF 驱动）
let lastPulseAt = 0;
let lastHintAt = 0;
let lastStartleAt = 0;
let lastShyAt = 0;
let hoverTimer = null;
let lastMouse = null;
let lastDrawAt = 0;
let persistTimer = null;

const FADE_MS = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 280;
/** idle 稳态降到 30fps（待机呼吸足够），过渡/拖拽/busy 保持满帧。 */
const IDLE_FRAME_MS = 33;
/** 鼠标快速冲向宠物（px/ms）判定为"惊吓"，节流 30s。 */
const STARTLE_SPEED = 2.2;
const STARTLE_THROTTLE_MS = 30_000;
/** 凝视宠物超过该时长触发"害羞"，节流 60s。 */
const SHY_HOVER_MS = 8_000;
const SHY_THROTTLE_MS = 60_000;
/** 高速接近采样窗口（ms）：速度按最近两次 mousemove 计算。 */
const SPEED_SAMPLE_MS = 40;

const halfW = computed(() => props.size / 2);
const halfH = computed(() => (props.size * 9) / 16 / 2);
const stageHeight = computed(() => (props.size * 9) / 16);

const slotEl = (slot) => (slot === 0 ? videoARef.value : videoBRef.value);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (1 - t) * (1 - t) * 2);

// ---- 渲染循环：稳态画 front，过渡时旧帧冻结垫底 + 新帧叠加淡入 ----
const drawVideo = (el, facingRight, alpha) => {
  if (!el || el.readyState < 2 || alpha <= 0) return;
  ctx2d.save();
  ctx2d.globalAlpha = alpha;
  if (facingRight) {
    ctx2d.translate(640, 0);
    ctx2d.scale(-1, 1);
  }
  ctx2d.drawImage(el, 0, 0, 640, 360);
  ctx2d.restore();
};

/** 脚下接地软阴影：脚底线（y=330）下方一个扁椭圆，宠物不"悬浮"；拖拽（悬空）时不画。 */
const drawShadow = () => {
  if (isDragging.value) return;
  ctx2d.save();
  ctx2d.translate(320, 342);
  ctx2d.scale(1, 0.16);
  const gradient = ctx2d.createRadialGradient(0, 0, 8, 0, 0, 150);
  gradient.addColorStop(0, 'rgba(0, 0, 0, 0.25)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx2d.fillStyle = gradient;
  ctx2d.beginPath();
  ctx2d.arc(0, 0, 150, 0, Math.PI * 2);
  ctx2d.fill();
  ctx2d.restore();
};

const renderLoop = (now) => {
  const active = transition !== null || isDragging.value || props.mood === 'busy' || props.hint;
  if (!active && now - lastDrawAt < IDLE_FRAME_MS) {
    rafId = requestAnimationFrame(renderLoop);
    return;
  }
  lastDrawAt = now;
  const frontEl = slotEl(front);
  const backEl = slotEl(1 - front);
  ctx2d.clearRect(0, 0, 640, 360);
  drawShadow();
  if (transition) {
    const t = FADE_MS === 0 ? 1 : Math.min(1, (now - transition.start) / FADE_MS);
    drawVideo(backEl, facingBySlot[1 - front] === 'right', 1); // 旧帧已暂停 = 冻结帧垫底
    drawVideo(frontEl, facingBySlot[front] === 'right', easeInOut(t));
    if (t >= 1) transition = null;
  } else {
    drawVideo(frontEl, facingBySlot[front] === 'right', 1);
  }
  rafId = requestAnimationFrame(renderLoop);
};

// ---- 双缓冲切换 ----
const switchTo = (next, nextOnce) => {
  if (pending && pending.anim === next && pending.once === nextOnce) return;
  const g = ++gen;
  pending = { anim: next, once: nextOnce, gen: g };

  const el = slotEl(1 - front);
  if (!el) return;
  el.src = `${props.assetBase}/${encodeURIComponent(next)}.webm`;
  el.loop = !nextOnce;
  el.muted = true;
  el.onended = nextOnce ? handleEnded : undefined;
  el.load();

  const onReady = () => {
    el.removeEventListener('loadeddata', onReady);
    if (!pending || pending.gen !== g) return;
    const oldEl = slotEl(front);
    oldEl.pause(); // 冻结旧帧，过渡期间不再变化（消除残影）
    el.play().catch(() => {});
    front = 1 - front;
    facingBySlot[front] = facing.value; // 新帧按当前朝向绘制；旧槽位保持自己的朝向
    pending = null;
    transition = { start: performance.now() };
    if (pendingMove) startMoveDrive(el);
  };
  el.addEventListener('loadeddata', onReady);
  if (el.readyState >= 2) onReady();
};

// anim/once/seq 任一变化即切视频；flush post 保证模板 ref 已就绪
watch(
  () => [anim.value, once.value, seq.value],
  () => switchTo(anim.value, once.value),
  { flush: 'post' },
);

// ---- 动画链 ----
const pickNextStep = () => {
  const next = pickNext({
    current: anim.value,
    catalog: catalog.value,
    mood: props.mood,
    facing: facing.value,
    centerX: currentCenterX(),
    centerY: currentCenterY(),
    viewportWidth: viewport.value.w,
    viewportHeight: viewport.value.h,
    halfW: halfW.value,
    halfH: halfH.value,
  });
  if (next.kind === 'move') pendingMove = next.plan;
  anim.value = next.anim;
  once.value = true;
  seq.value += 1;
};

/** 立即打断当前动画播放指定动画（点击回应 / error / done 脉冲共用）。 */
const interruptWith = (next) => {
  stopMove();
  anim.value = next;
  once.value = true;
  seq.value += 1;
};

const handleEnded = () => {
  if (dragState.active) return; // 拖拽中不打断
  if (anim.value === TURN) facing.value = facing.value === 'left' ? 'right' : 'left';
  // 用户打断/脉冲触发的动画（点击回应/拖拽/炸毛/庆祝）播完 → 先回待机缓冲
  const isInterruptAnim =
    anim.value === catalog.value.drag || catalog.value.clicks.includes(anim.value) || anim.value === catalog.value.error || catalog.value.done.includes(anim.value);
  if (isInterruptAnim) {
    anim.value = IDLE;
    once.value = true;
    seq.value += 1;
    return;
  }
  pickNextStep();
};

// ---- agent 状态脉冲（error/done 各触发一次） ----
watch(
  () => props.pulse,
  (pulse) => {
    if (!pulse || pulse.at === lastPulseAt) return;
    lastPulseAt = pulse.at;
    if (pulse.kind === 'error' && catalog.value.error) {
      interruptWith(catalog.value.error);
    } else if (pulse.kind === 'done' && catalog.value.done.length > 0) {
      interruptWith(pick(catalog.value.done));
    }
  },
);

// mood 翻转到 busy 时立即打断换工作姿态（不等当前动画播完，反应即时可感）
watch(
  () => props.mood,
  (mood, previous) => {
    if (mood === 'busy' && previous !== 'busy' && !dragState.active && catalog.value.busy.length > 0) {
      interruptWith(pick(catalog.value.busy));
    }
  },
);

// busy 期间的工具映射提示：agent 用什么工具 → 宠物演对应动画（后端已节流 8s）
watch(
  () => props.hint,
  (hint) => {
    if (!hint || hint.at === lastHintAt) return;
    lastHintAt = hint.at;
    if (props.mood !== 'busy' || dragState.active) return;
    const available = catalog.value.acts.includes(hint.anim) || catalog.value.busy.includes(hint.anim);
    if (available) interruptWith(hint.anim);
  },
);

// ---- 位置记忆（按显示器分键，重启后留在原地） ----
const positionKey = computed(() => `ragsystem-pet-position-${props.display}`);

const restorePosition = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(positionKey.value) ?? 'null');
    if (
      saved &&
      typeof saved.rx === 'number' && Number.isFinite(saved.rx) &&
      typeof saved.ry === 'number' && Number.isFinite(saved.ry) &&
      saved.rx >= 0 && saved.rx <= 1 && saved.ry >= 0 && saved.ry <= 1
    ) {
      customPos.value = { rx: saved.rx, ry: saved.ry };
    }
  } catch {
    // 坏数据忽略，回默认角落
  }
};

watch(
  () => customPos.value,
  (position) => {
    if (!position) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        localStorage.setItem(positionKey.value, JSON.stringify(position));
      } catch {
        // 存储不可用（隐私模式等）忽略
      }
    }, 500);
  },
);

// ---- 双击 → 快速对话（PetView 弹输入框） ----
const onDoubleClick = () => {
  const rect = rootRef.value?.getBoundingClientRect();
  emit('quick-ask', rect ? { x: rect.left + rect.width / 2, y: rect.top } : null);
};

// ---- 鼠标互动：高速接近受惊 / 长凝视害羞 ----
const isOverPet = (x, y) => {
  const rect = rootRef.value?.getBoundingClientRect();
  if (!rect) return false;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
};

const onGlobalMouseMove = (event) => {
  const now = performance.now();
  const previous = lastMouse;
  lastMouse = { x: event.clientX, y: event.clientY, t: now };
  if (!previous || dragState.active) return;
  const dt = now - previous.t;
  if (dt < 4 || dt > SPEED_SAMPLE_MS) return; // 采样窗口外不计算（事件批处理抖动）
  const speed = Math.hypot(event.clientX - previous.x, event.clientY - previous.y) / dt;
  if (
    speed > STARTLE_SPEED &&
    isOverPet(event.clientX, event.clientY) &&
    now - lastStartleAt > STARTLE_THROTTLE_MS &&
    catalog.value.error
  ) {
    lastStartleAt = now;
    interruptWith(catalog.value.error);
  }
};

const onHitEnter = () => {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (dragState.active || performance.now() - lastShyAt < SHY_THROTTLE_MS) return;
    const shy = catalog.value.clicks.find((name) => name.includes('害羞'));
    if (shy) {
      lastShyAt = performance.now();
      interruptWith(shy);
    }
  }, SHY_HOVER_MS);
};

const onHitLeave = () => {
  clearTimeout(hoverTimer);
};

// ---- 位置（视口比例制） ----
const currentCenterX = () => {
  if (customPos.value) return customPos.value.rx * viewport.value.w;
  const el = rootRef.value;
  if (el) return el.getBoundingClientRect().left + halfW.value;
  return viewport.value.w - 24 - halfW.value;
};
const currentCenterY = () => {
  if (customPos.value) return customPos.value.ry * viewport.value.h;
  const el = rootRef.value;
  if (el) return el.getBoundingClientRect().top + halfH.value;
  return viewport.value.h - 20 - halfH.value;
};

// ---- 移动驱动（跟随视频播放时钟） ----
const startMoveDrive = (el) => {
  const plan = pendingMove;
  if (!plan || moveRaf !== null) return;
  pendingMove = null;
  const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
  const token = ++moveToken;
  const step = () => {
    if (moveToken !== token) return;
    const rootEl = rootRef.value;
    if (rootEl) {
      const ratioX = moveProgressRatio({ plan, currentTime: el.currentTime || 0, duration });
      rootEl.style.left = `${ratioX * viewport.value.w - halfW.value}px`;
      rootEl.style.top = `${plan.startYRatio * viewport.value.h - halfH.value}px`;
      rootEl.style.right = 'auto';
      rootEl.style.bottom = 'auto';
    }
    if ((el.currentTime || 0) < duration - MOVE_TAIL_SEC) {
      moveRaf = requestAnimationFrame(step);
    } else {
      moveRaf = null;
      customPos.value = { rx: plan.targetRatio, ry: plan.startYRatio };
    }
  };
  moveRaf = requestAnimationFrame(step);
};

const stopMove = () => {
  pendingMove = null;
  moveToken += 1;
  if (moveRaf !== null) {
    cancelAnimationFrame(moveRaf);
    moveRaf = null;
  }
};

// ---- 点击与拖拽 ----
const onPointerDown = (event) => {
  stopMove();
  event.currentTarget.setPointerCapture(event.pointerId);
  const rect = rootRef.value?.getBoundingClientRect();
  // 记录鼠标相对舞台中心的偏移：从任意部位抓起都不瞬移
  dragState = {
    active: true,
    dragging: false,
    sx: event.clientX,
    sy: event.clientY,
    offX: rect ? event.clientX - (rect.left + rect.width / 2) : 0,
    offY: rect ? event.clientY - (rect.top + rect.height / 2) : 0,
  };
};

const onPointerMove = (event) => {
  const d = dragState;
  if (!d.active) return;
  const dx = event.clientX - d.sx;
  const dy = event.clientY - d.sy;
  if (!d.dragging) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    d.dragging = true;
    isDragging.value = true;
    if (catalog.value.drag) {
      anim.value = catalog.value.drag;
      once.value = true;
      seq.value += 1;
    }
  }
  const el = rootRef.value;
  if (el) {
    el.style.left = `${event.clientX - d.offX - halfW.value}px`;
    el.style.top = `${event.clientY - d.offY - halfH.value}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
};

const onPointerUp = (event) => {
  const d = dragState;
  const wasDragging = d.dragging;
  d.active = false;
  d.dragging = false;
  if (!wasDragging) return;
  justDragged = true; // 抑制拖拽结束后的幽灵 click
  setTimeout(() => {
    justDragged = false;
  }, 100);
  isDragging.value = false;
  customPos.value = {
    rx: (event.clientX - d.offX) / viewport.value.w,
    ry: (event.clientY - d.offY) / viewport.value.h,
  };
  anim.value = IDLE;
  once.value = false;
  seq.value += 1;
};

const onClick = () => {
  if (dragState.active || dragState.dragging || justDragged) return;
  if (once.value && anim.value !== IDLE) return; // 一次性动画播放中不打断
  if (catalog.value.clicks.length === 0) return;
  interruptWith(pick(catalog.value.clicks));
};

// ---- 渲染样式 ----
const bottomPad = computed(() => feetBottomPad(stageHeight.value));
const stageStyle = computed(() => (isDragging.value ? { transform: 'none' } : { transform: `translateY(${bottomPad.value}px)` }));

const rootStyle = computed(() => {
  const style = { '--pet-size': `${props.size}px` };
  const pos = customPos.value;
  if (pos) {
    // 比例 × 当前视口尺寸定位，并钳制在窗口内（窗口缩小时不跑出屏幕）
    const left = Math.min(Math.max(pos.rx * viewport.value.w - halfW.value, 0), viewport.value.w - props.size);
    const top = Math.min(Math.max(pos.ry * viewport.value.h - halfH.value, 0), viewport.value.h - stageHeight.value);
    style.left = `${left}px`;
    style.top = `${top}px`;
    style.right = 'auto';
    style.bottom = 'auto';
  }
  return style;
});

const hitStyle = computed(() => ({
  left: `${(HIT_BOX.x0 / 640) * 100}%`,
  top: `${(HIT_BOX.y0 / 360) * 100}%`,
  width: `${((HIT_BOX.x1 - HIT_BOX.x0) / 640) * 100}%`,
  height: `${((HIT_BOX.y1 - HIT_BOX.y0) / 360) * 100}%`,
}));

// ---- 生命周期 ----
const onResize = () => {
  viewport.value = { w: window.innerWidth, h: window.innerHeight };
};

onMounted(() => {
  onResize();
  window.addEventListener('resize', onResize);
  document.addEventListener('mousemove', onGlobalMouseMove);
  restorePosition();
  ctx2d = canvasRef.value.getContext('2d');
  rafId = requestAnimationFrame(renderLoop);
  switchTo(anim.value, once.value);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  document.removeEventListener('mousemove', onGlobalMouseMove);
  clearTimeout(hoverTimer);
  clearTimeout(persistTimer);
  stopMove();
  if (rafId !== null) cancelAnimationFrame(rafId);
});
</script>

<style scoped>
.pet-root {
  position: fixed;
  z-index: 40;
  pointer-events: none;
  user-select: none;
}

.pet-root[data-corner='bottom-right'] {
  right: 24px;
  bottom: 0;
}

.pet-root[data-corner='bottom-left'] {
  left: 24px;
  bottom: 0;
}

.pet-stage {
  position: relative;
  width: var(--pet-size);
  height: calc(var(--pet-size) * 9 / 16);
  pointer-events: none;
}

/* 可见画布：640×360 原生分辨率绘制，CSS 等比铺满舞台 */
.pet-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}

/* 解码用隐藏视频：不参与显示与交互，仅由 canvas 绘制 */
.pet-video {
  position: absolute;
  left: 0;
  top: 0;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.pet-hit {
  position: absolute;
  pointer-events: auto;
  cursor: grab;
  z-index: 1;
}

.pet-hit.dragging {
  cursor: grabbing;
}

/* 头顶状态气泡：系统风（深色浮层面 + 分层阴影 + 低饱和状态色 token）×
   宠物风（对话小尾巴 + spring 弹跳入场）。锚在 pet-root 顶部（画布 y=0..50 本就是头顶留白） */
.pet-notice {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 18px 10px 15px;
  border-radius: var(--radius-2xl, 12px);
  background: rgba(32, 32, 32, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.07),
    0 2px 8px rgba(0, 0, 0, 0.32),
    0 10px 32px rgba(0, 0, 0, 0.42);
  color: var(--color-text-primary, #fafafa);
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0.3px;
  white-space: nowrap;
  pointer-events: none;
}

/* 指向宠物头顶的小尾巴 */
.pet-notice::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -5.5px;
  width: 11px;
  height: 11px;
  background: rgba(32, 32, 32, 0.95);
  border-right: 1px solid rgba(255, 255, 255, 0.14);
  border-bottom: 1px solid rgba(255, 255, 255, 0.14);
  transform: translateX(-50%) rotate(45deg);
}

.pet-notice-icon {
  width: 15px;
  height: 15px;
  flex: none;
  color: var(--color-text-secondary, #b3b3b3);
}

.pet-notice-icon .stroke {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.pet-notice-icon .fill {
  fill: currentColor;
}

/* done 最有分量：状态色描边 + 图标光晕 + 加粗 */
.pet-notice.done {
  border-color: rgba(var(--color-success-rgb, 87, 171, 90), 0.42);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.07),
    0 2px 8px rgba(0, 0, 0, 0.32),
    0 10px 32px rgba(0, 0, 0, 0.42),
    0 0 20px rgba(var(--color-success-rgb, 87, 171, 90), 0.16);
  font-weight: 600;
}

.pet-notice.done .pet-notice-icon {
  color: var(--color-success, #57ab5a);
  filter: drop-shadow(0 0 5px rgba(var(--color-success-rgb, 87, 171, 90), 0.55));
}

.pet-notice.error {
  border-color: rgba(var(--color-error-rgb, 224, 82, 76), 0.4);
}

.pet-notice.error .pet-notice-icon {
  color: var(--color-error, #e0524c);
  filter: drop-shadow(0 0 5px rgba(var(--color-error-rgb, 224, 82, 76), 0.5));
}

/* spring 弹跳入场（宠物风），收起轻淡出 */
.pet-notice-enter-active {
  transition:
    opacity 0.32s ease-out,
    transform 0.32s var(--ease-spring, cubic-bezier(0.34, 1.56, 0.64, 1));
}

.pet-notice-leave-active {
  transition: opacity 0.18s ease-in, transform 0.18s ease-in;
}

.pet-notice-enter-from {
  opacity: 0;
  transform: translateX(-50%) translateY(10px) scale(0.86);
}

.pet-notice-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-6px) scale(0.95);
}
</style>
