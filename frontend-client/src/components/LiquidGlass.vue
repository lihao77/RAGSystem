<template>
  <div ref="hostRef" class="liquid-glass-host" :style="hostStyle">
    <!-- SVG displacement filter (hidden) -->
    <svg
      ref="svgRef"
      xmlns="http://www.w3.org/2000/svg"
      width="0"
      height="0"
      :style="{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', overflow: 'visible' }"
    >
      <defs>
        <filter
          :id="filterId"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB"
          x="0" y="0"
          :width="width"
          :height="height"
        >
          <feImage ref="feImageRef" :id="filterId + '_map'" :width="width" :height="height" />
          <feDisplacementMap
            ref="feDisplacementRef"
            in="SourceGraphic"
            :in2="filterId + '_map'"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>

    <!-- Canvas (hidden, used to generate displacement map) -->
    <canvas ref="canvasRef" style="display: none;" />

    <!-- Glass surface -->
    <div ref="glassRef" class="liquid-glass-surface" :style="glassStyle">
      <slot />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'

const props = defineProps({
  width: { type: Number, default: 300 },
  height: { type: Number, default: 64 },
  radius: { type: Number, default: 999 }, // large = pill/capsule
  draggable: { type: Boolean, default: false },
  /** extra backdrop-filter to stack on top of displacement */
  extraFilter: { type: String, default: 'blur(0.5px) contrast(1.15) brightness(1.06) saturate(1.1)' },
})

// ── Unique filter id per instance ──
const filterId = 'lg-' + Math.random().toString(36).slice(2, 9)

// ── Template refs ──
const hostRef = ref(null)
const svgRef = ref(null)
const feImageRef = ref(null)
const feDisplacementRef = ref(null)
const canvasRef = ref(null)
const glassRef = ref(null)

// ── Drag state ──
const dragPos = ref({ x: 0, y: 0, active: false })
let isDragging = false
let startX = 0, startY = 0, originX = 0, originY = 0

// ── Computed styles ──
const hostStyle = computed(() => ({
  position: dragPos.value.active ? 'fixed' : props.draggable ? 'relative' : undefined,
  left: dragPos.value.active ? dragPos.value.x + 'px' : undefined,
  top: dragPos.value.active ? dragPos.value.y + 'px' : undefined,
  width: props.width + 'px',
  height: props.height + 'px',
  cursor: props.draggable ? (isDragging ? 'grabbing' : 'grab') : undefined,
  userSelect: props.draggable ? 'none' : undefined,
  pointerEvents: 'auto',
  zIndex: dragPos.value.active ? 30 : undefined,
}))

const glassStyle = computed(() => ({
  position: 'absolute',
  inset: '0',
  borderRadius: Math.min(props.radius, props.height / 2) + 'px',
  backdropFilter: `url(#${filterId}) ${props.extraFilter}`,
  WebkitBackdropFilter: `url(#${filterId}) ${props.extraFilter}`,
  overflow: 'hidden',
  boxShadow: [
    '0 2px 8px rgba(0,0,0,0.18)',
    '0 1px 0 rgba(255,255,255,0.22) inset',
    '0 -1px 0 rgba(255,255,255,0.12) inset',
  ].join(', '),
  background: [
    'linear-gradient(160deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.04) 40%, rgba(255,255,255,0.10) 100%)',
  ].join(', '),
}))

// ── SDF helpers (mirror of liquid-glass.js) ──
function smoothStep(a, b, t) {
  t = Math.max(0, Math.min(1, (t - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
function len(x, y) { return Math.sqrt(x * x + y * y) }
function roundedRectSDF(x, y, hw, hh, r) {
  const qx = Math.abs(x) - hw + r
  const qy = Math.abs(y) - hh + r
  return Math.min(Math.max(qx, qy), 0) + len(Math.max(qx, 0), Math.max(qy, 0)) - r
}

// ── Render displacement map onto canvas → SVG filter ──
function renderShader() {
  const canvas = canvasRef.value
  const feImage = feImageRef.value
  const feDisp = feDisplacementRef.value
  if (!canvas || !feImage || !feDisp) return

  const w = props.width
  const h = props.height
  canvas.width = w
  canvas.height = h

  const ctx = canvas.getContext('2d')
  const imgData = new ImageData(w, h)
  const data = imgData.data

  const rawX = new Float32Array(w * h)
  const rawY = new Float32Array(w * h)
  let maxScale = 0

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      // UV space [0,1] → centered [-0.5, 0.5], matching original liquid-glass.js
      const ix = px / w - 0.5
      const iy = py / h - 0.5

      // SDF in UV space. hw/hh are half-extents, r is corner radius — all in UV units.
      // For a pill/capsule: r should be ~0.5 in the short axis
      const aspect = w / h
      const uvR = Math.min(props.radius / h, 0.5)
      const uvHH = 0.5 - uvR
      const uvHW = 0.5 * aspect - uvR

      const distanceToEdge = roundedRectSDF(ix * aspect, iy, uvHW < 0 ? 0 : uvHW, uvHH < 0 ? 0 : uvHH, uvR)

      // Exact same formula as original demo
      const displacement = smoothStep(0.8, 0, distanceToEdge - 0.15)
      const scaled = smoothStep(0, 1, displacement)

      const outUvX = ix * scaled + 0.5
      const outUvY = iy * scaled + 0.5

      const idx = py * w + px
      const dx = outUvX * w - px
      const dy = outUvY * h - py
      rawX[idx] = dx
      rawY[idx] = dy
      if (Math.abs(dx) > maxScale) maxScale = Math.abs(dx)
      if (Math.abs(dy) > maxScale) maxScale = Math.abs(dy)
    }
  }

  maxScale = Math.max(maxScale * 0.5, 1)

  for (let i = 0; i < w * h; i++) {
    const rv = rawX[i] / maxScale + 0.5
    const gv = rawY[i] / maxScale + 0.5
    const base = i * 4
    data[base]     = rv * 255
    data[base + 1] = gv * 255
    data[base + 2] = 0
    data[base + 3] = 255
  }

  ctx.putImageData(imgData, 0, 0)

  feImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href', canvas.toDataURL())
  feDisp.setAttribute('scale', String(maxScale))
}

// ── Drag ──
function setupDrag() {
  const host = hostRef.value
  if (!host || !props.draggable) return

  const onDown = (e) => {
    isDragging = true
    const rect = host.getBoundingClientRect()
    dragPos.value = {
      x: rect.left,
      y: rect.top,
      active: true,
    }
    startX = e.clientX
    startY = e.clientY
    originX = rect.left
    originY = rect.top
    e.preventDefault()
  }

  const onMove = (e) => {
    if (!isDragging) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    dragPos.value = {
      x: originX + dx,
      y: originY + dy,
      active: true,
    }
  }

  const onUp = () => {
    isDragging = false
  }

  host.addEventListener('pointerdown', onDown)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)

  onBeforeUnmount(() => {
    host.removeEventListener('pointerdown', onDown)
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  })
}

// ── Lifecycle ──
onMounted(() => {
  renderShader()
  setupDrag()
})

watch(() => [props.width, props.height, props.radius], () => {
  renderShader()
})
</script>

<style scoped>
.liquid-glass-host {
  display: inline-block;
  isolation: isolate;
}
.liquid-glass-surface {
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
