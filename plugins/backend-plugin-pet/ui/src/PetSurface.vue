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
    <!-- 状态气泡：挂在 pet-root 内，拖拽/漫游时随根元素一起移动。
         图标用 dsh-pet 0.2.0 的 AI 生成通知图（MIT 素材，Vite 打包输出） -->
    <Transition name="pet-notice">
      <div v-if="notice" class="pet-notice" :class="notice.kind" role="status">
        <img class="pet-notice-icon" :src="NOTICE_ICONS[notice.icon] ?? NOTICE_ICONS.done" alt="" draggable="false">
        <span>{{ notice.text }}</span>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import iconDone from './assets/notify-done.png';
import iconError from './assets/notify-error.png';
import {
  BASE_PET_SIZE,
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
 * 桌宠本体：双缓冲 webm 播放 + 概率动画链 + 点击/拖拽/漫游互动。纯桌宠——不联动
 * agent 状态（任务事件提示走系统桌面通知，见 PetPanel），移植自 dsh-pet（MIT）
 * lib/client.js，渲染层重写为 canvas 合成：
 *
 * - 两个隐藏 <video> 负责解码，可见 <canvas> 每帧绘制（640×360 原生分辨率）。
 * - 切换动画时旧视频先 pause（冻结帧、alpha=1）垫底，新视频以缓动 alpha 叠加淡入——
 *   相比两个 video 元素的 CSS 交叉淡入（过渡瞬间双方半透明、人物“透底”），
 *   合成淡入保证任意时刻整体不透明，消除切换痕迹。
 * - 每个视频槽位记忆自己的朝向（镜像在绘制时按槽位应用），淡出帧保持原朝向。
 * - 以递增“代数”gen 丢弃过期就绪回调，防止快速连点把画面切丢。
 * - 链式模型：所有动画一次性播放，ended 按概率选下一个（10/5/80/5）。
 */
const emit = defineEmits(['quick-ask']);

/** 气泡图标（dsh-pet AI 生成通知图）按语义映射；任务事件已走系统通知，仅剩 quick-ask 反馈。 */
const NOTICE_ICONS = { done: iconDone, error: iconError };

const props = defineProps({
  /** 舞台宽度（px），高 = 宽 × 9/16。 */
  size: { type: Number, default: 462 },
  corner: { type: String, default: 'bottom-right' },
  assetBase: { type: String, default: '/api/pet/thumb' },
  /** 后端 manifest 的可用动画名；null = 假定全套素材齐全。 */
  available: { type: Array, default: null },
  /** 初始动画名（场景配置 default_animation）；素材清单里没有时回退待机。 */
  initialAnim: { type: String, default: null },
  /** 显示器索引（多显示器时每窗一个），位置记忆按其分键。 */
  display: { type: [String, Number], default: '0' },
  /** 独立桌宠小窗的显示器工作区 {x,y,w,h}（主进程经 URL 注入）；null = 宿主页内嵌。
   *  独立模式下定位坐标系 = 整个显示器工作区，屏幕位置由"窗口跟随"承载。 */
  displayRect: { type: Object, default: null },
  /** 快速对话输入框打开（PetPanel 渲染在宠物左上）：小窗需向左上扩展预留空间。 */
  quickAskOpen: { type: Boolean, default: false },
  /** 头顶反馈气泡 { kind: 'done'|'error'|'info', icon: 'done'|'error'|'approval'|'question', text }；null = 隐藏。 */
  notice: { type: Object, default: null },
});

const catalog = computed(() => buildCatalog(props.available));

/** 独立小窗的画布外边距（窗口贴住本体）；quick-ask 打开时的左上扩展量。 */
const WIN_PAD = 8;
const QUICK_W = 340;
const QUICK_H = 96;

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
/** 宠物左上角在定位坐标系（独立小窗 = 显示器工作区；内嵌 = 宿主视口）的坐标。 */
const virtualPos = ref(null);
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
  const active = transition !== null || isDragging.value;
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
    facing: facing.value,
    scale: props.size / BASE_PET_SIZE,
    centerX: currentCenterX(),
    centerY: currentCenterY(),
    viewportWidth: screenRect.value.w,
    viewportHeight: screenRect.value.h,
    // 漫游贴边边界按"人物本体"算而非画布：人物宽约为画布宽 37.5%（居中，
    // x∈[200,440]/640），画布半宽换成身体半宽后才能走到贴近屏幕边缘
    halfW: halfW.value * 0.375,
    halfH: halfH.value,
  });
  if (next.kind === 'move') pendingMove = next.plan;
  anim.value = next.anim;
  once.value = true;
  seq.value += 1;
};

/** 立即打断当前动画播放指定动画（点击回应 / 受惊共用）。 */
const interruptWith = (next) => {
  stopMove();
  anim.value = next;
  once.value = true;
  seq.value += 1;
};

const handleEnded = () => {
  if (dragState.active) return; // 拖拽中不打断
  if (anim.value === TURN) facing.value = facing.value === 'left' ? 'right' : 'left';
  // 用户打断触发的动画（点击回应/拖拽/受惊）播完 → 先回待机缓冲
  const isInterruptAnim = anim.value === catalog.value.drag || catalog.value.clicks.includes(anim.value);
  if (isInterruptAnim) {
    anim.value = IDLE;
    once.value = true;
    seq.value += 1;
    return;
  }
  pickNextStep();
};

// ---- 位置记忆（按显示器分键，重启后留在原地） ----
const positionKey = computed(() => `ragsystem-pet-position-${props.display}`);

const restorePosition = () => {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(positionKey.value) ?? 'null');
  } catch {
    // 坏数据忽略，回默认角落
  }
  const valid = saved
    && typeof saved.rx === 'number' && Number.isFinite(saved.rx)
    && typeof saved.ry === 'number' && Number.isFinite(saved.ry)
    && saved.rx >= 0 && saved.rx <= 1 && saved.ry >= 0 && saved.ry <= 1;
  const width = screenRect.value.w || 1920;
  const height = screenRect.value.h || 1080;
  if (valid) {
    customPos.value = { rx: saved.rx, ry: saved.ry };
    applyVirtual(saved.rx * width - halfW.value, saved.ry * height - halfH.value);
    return;
  }
  // 默认角落与 data-corner=bottom-right 的 CSS 等价：right = 24 - size×31.25%
  applyVirtual(width - halfW.value * 2 - 24 + props.size * 0.3125, height - stageHeight.value);
};

// 位置记忆统一从 virtualPos 落盘（比例制，与历史存储兼容；独立小窗/内嵌同源）
watch(
  () => virtualPos.value,
  (position) => {
    if (!position) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const width = screenRect.value.w || 1;
      const height = screenRect.value.h || 1;
      try {
        localStorage.setItem(positionKey.value, JSON.stringify({
          rx: (position.x + halfW.value) / width,
          ry: (position.y + halfH.value) / height,
        }));
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

// ---- 定位（显示器工作区坐标制） ----
/** 定位坐标系：独立小窗 = 显示器工作区（URL 注入）；内嵌 = 宿主视口（resize 跟踪）。 */
const screenRect = computed(() => (
  props.displayRect && props.displayRect.w > 0 ? props.displayRect : viewport.value
));

const clampVirtualX = (x) => {
  const width = screenRect.value.w;
  const size = halfW.value * 2;
  // 漫游贴边边界按"人物本体"算而非画布：人物宽约为画布宽 37.5%（居中，
  // x∈[200,440]/640），画布半宽换成身体半宽后才能走到贴近屏幕边缘
  const bodyLeft = -size * (200 / 640);
  const bodyRight = width - size * (440 / 640);
  return Math.min(Math.max(x, bodyLeft), bodyRight);
};

const clampVirtualY = (y) => {
  const height = screenRect.value.h;
  // 头顶画布 y=50、脚底 y=330（另有 30/360 舞台下沉），画布透明留白可出屏、本体留屏内
  const headTop = -stageHeight.value * (80 / 360);
  const feetBottom = height - stageHeight.value;
  return Math.min(Math.max(y, headTop), feetBottom);
};

let boundsSending = false;
let pendingBounds = null;
/** 独立小窗：窗口矩形 = 宠物画布外扩边距（quick-ask 打开时向左上扩展）。串行发送、
 *  同时最多一个 in-flight IPC，漫游 rAF 频率下不会堆积。 */
const syncWindowBounds = () => {
  if (!props.displayRect || !virtualPos.value) return;
  const expandLeft = props.quickAskOpen ? QUICK_W : 0;
  const expandTop = props.quickAskOpen ? QUICK_H : 0;
  pendingBounds = {
    x: Math.round(props.displayRect.x + virtualPos.value.x - WIN_PAD - expandLeft),
    y: Math.round(props.displayRect.y + virtualPos.value.y - WIN_PAD - expandTop),
    width: Math.round(halfW.value * 2 + WIN_PAD * 2 + expandLeft),
    height: Math.round(stageHeight.value + WIN_PAD * 2 + expandTop),
  };
  if (boundsSending) return;
  boundsSending = true;
  const drain = async () => {
    while (pendingBounds) {
      const bounds = pendingBounds;
      pendingBounds = null;
      try {
        await window.ragsystemDesktop?.setPetBounds?.(bounds);
      } catch {
        // 主进程为旧版（无 handler）：窗口不跟随，宠物仍在本窗内渲染
      }
    }
    boundsSending = false;
  };
  void drain();
};

/** 统一落位：独立小窗更新虚拟坐标并驱动窗口跟随；内嵌模式直接写元素样式（与旧
 *  漫游驱动的命令式定位一致，customPos 仅在拖拽/漫游收尾时更新触发声明式重算）。 */
const applyVirtual = (x, y) => {
  const pos = { x: clampVirtualX(x), y: clampVirtualY(y) };
  virtualPos.value = pos;
  if (props.displayRect) {
    syncWindowBounds();
    return;
  }
  const el = rootRef.value;
  if (el) {
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
};

const currentCenterX = () => (
  virtualPos.value ? virtualPos.value.x + halfW.value : screenRect.value.w - 24 - halfW.value
);
const currentCenterY = () => (
  virtualPos.value ? virtualPos.value.y + halfH.value : screenRect.value.h - 20 - halfH.value
);

// ---- 移动驱动（跟随视频播放时钟） ----
const startMoveDrive = (el) => {
  const plan = pendingMove;
  if (!plan || moveRaf !== null) return;
  pendingMove = null;
  const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 10.09;
  const token = ++moveToken;
  const step = () => {
    if (moveToken !== token) return;
    const ratioX = moveProgressRatio({ plan, currentTime: el.currentTime || 0, duration });
    applyVirtual(ratioX * screenRect.value.w - halfW.value, plan.startYRatio * screenRect.value.h - halfH.value);
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
/** 独立小窗模式下取屏幕绝对坐标（窗口跟随指针移动，clientX 随窗口原点漂移不可用）。 */
const readScreenCursor = async () => {
  try {
    return (await window.ragsystemDesktop?.getCursorScreenPos?.()) ?? null;
  } catch {
    return null; // 旧 preload 无此 API：拖拽退化为不可移动（点击等其他交互不受影响）
  }
};

const beginDragVisual = (d) => {
  d.dragging = true;
  isDragging.value = true;
  if (catalog.value.drag) {
    anim.value = catalog.value.drag;
    once.value = true;
    seq.value += 1;
  }
};

const onPointerDown = async (event) => {
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
  if (!props.displayRect) return;
  // 独立小窗：抓取点改用屏幕坐标（grabX/Y = 光标到宠物左上角的偏移）
  const cursor = await readScreenCursor();
  if (!cursor || !dragState.active) return; // IPC 往返期间已松手
  const vx = cursor.x - props.displayRect.x;
  const vy = cursor.y - props.displayRect.y;
  dragState.grabX = vx - (virtualPos.value?.x ?? 0);
  dragState.grabY = vy - (virtualPos.value?.y ?? 0);
  dragState.startVX = vx;
  dragState.startVY = vy;
};

const onPointerMove = async (event) => {
  const d = dragState;
  if (!d.active) return;
  if (props.displayRect) {
    const cursor = await readScreenCursor();
    if (!cursor || !d.active) return;
    const vx = cursor.x - props.displayRect.x;
    const vy = cursor.y - props.displayRect.y;
    if (!d.dragging && Math.hypot(vx - d.startVX, vy - d.startVY) < DRAG_THRESHOLD) return;
    if (!d.dragging) beginDragVisual(d);
    applyVirtual(vx - d.grabX, vy - d.grabY);
    return;
  }
  const dx = event.clientX - d.sx;
  const dy = event.clientY - d.sy;
  if (!d.dragging) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    beginDragVisual(d);
  }
  applyVirtual(event.clientX - d.offX - halfW.value, event.clientY - d.offY - halfH.value);
};

const onPointerUp = () => {
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
  const width = screenRect.value.w || 1;
  const height = screenRect.value.h || 1;
  const pos = virtualPos.value;
  customPos.value = pos
    ? { rx: (pos.x + halfW.value) / width, ry: (pos.y + halfH.value) / height }
    : null;
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
  if (props.displayRect) {
    // 独立小窗：本体钉在窗口内固定位置（quick-ask 打开时随窗口扩展左移下移同样偏移，
    // 屏幕位置不变），屏幕漫游由窗口跟随承载（applyVirtual → pet:set-bounds）
    return {
      '--pet-size': `${props.size}px`,
      left: `${WIN_PAD + (props.quickAskOpen ? QUICK_W : 0)}px`,
      top: `${WIN_PAD + (props.quickAskOpen ? QUICK_H : 0)}px`,
      right: 'auto',
      bottom: 'auto',
    };
  }
  const style = { '--pet-size': `${props.size}px` };
  const pos = customPos.value;
  if (pos) {
    // 比例 × 当前视口尺寸定位；钳制按"人物本体"而非画布（人物占画布 x∈[200,440]/640，
    // 头顶画布 y=50、脚底 y=330，另有 30/360 的舞台下沉把脚贴到 root 底缘——
    // 人物可视区相对 root 顶为 y∈[80,360]/360）——画布透明留白可以出屏，人物本体留在屏内，
    // 这样能拖到贴边（与角落定位的负偏移补偿同一套几何）
    const left = clampVirtualX(pos.rx * screenRect.value.w - halfW.value);
    const top = clampVirtualY(pos.ry * screenRect.value.h - halfH.value);
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

// 独立小窗：quick-ask 开合扩展/收缩窗口、场景缩放改变窗口尺寸（内嵌模式自动短路）
watch(
  () => [props.quickAskOpen, props.size],
  () => syncWindowBounds(),
);

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

/* 角落定位锚定人物本体而非画布：640×360 画布人物居中，身体右/左缘约在 x=440/x=200
   （HIT_BOX），侧边留白占画布宽 31.25%——若按画布边缘算距离，人物会离屏幕边
   ~31%×画布宽（约 200px）。负偏移补偿后人物本体距边 24px。 */
.pet-root[data-corner='bottom-right'] {
  right: calc(24px - var(--pet-size) * 0.3125);
  bottom: 0;
}

.pet-root[data-corner='bottom-left'] {
  left: calc(24px - var(--pet-size) * 0.3125);
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

/* 手套光标（同步 dsh-pet 0.2.0，MIT）：小图由 Vite 内联 data URI，热点取掌心 */
.pet-hit {
  position: absolute;
  pointer-events: auto;
  cursor: url('./assets/cursor-grab.png') 16 16, grab;
  z-index: 1;
}

.pet-hit.dragging {
  cursor: url('./assets/cursor-grabbing.png') 16 16, grabbing;
}

/* 头顶通知气泡：自足配色（不依赖主题变量——独立宠物窗无主题上下文，且主题文字色
   会与固定深底冲突导致看不清）：深色玻璃底 + 纯白文字 + AI 图标。
   锚在 pet-root 顶部（画布 y=0..50 本就是头顶留白） */
.pet-notice {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: min(480px, 76vw);
  padding: 8px 15px 8px 9px;
  border-radius: 14px;
  background: rgba(21, 23, 28, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.15);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.07),
    0 4px 14px rgba(0, 0, 0, 0.35),
    0 12px 36px rgba(0, 0, 0, 0.45);
  color: #ffffff;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.2px;
  white-space: nowrap;
  pointer-events: none;
}

.pet-notice span {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 指向宠物头顶的小尾巴 */
.pet-notice::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -5.5px;
  width: 11px;
  height: 11px;
  background: rgba(21, 23, 28, 0.94);
  border-right: 1px solid rgba(255, 255, 255, 0.15);
  border-bottom: 1px solid rgba(255, 255, 255, 0.15);
  transform: translateX(-50%) rotate(45deg);
}

/* 气泡图标：dsh-pet AI 生成通知图（方形 PNG，微圆角融入浮层） */
.pet-notice-icon {
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 5px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
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

.pet-notice.error {
  border-color: rgba(var(--color-error-rgb, 224, 82, 76), 0.4);
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
