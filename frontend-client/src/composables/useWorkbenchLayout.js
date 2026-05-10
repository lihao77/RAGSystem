import { ref, computed, onMounted, onUnmounted } from 'vue'

const WIDE_BREAKPOINT = 1200

export function useWorkbenchLayout() {
  const isWideScreen = ref(false)
  const _manualOverride = ref(null) // null = auto, true/false = manual

  let mq = null

  function onMediaChange(e) {
    isWideScreen.value = e.matches
    _manualOverride.value = null // Reset override when screen size changes
  }

  onMounted(() => {
    mq = window.matchMedia(`(min-width: ${WIDE_BREAKPOINT}px)`)
    isWideScreen.value = mq.matches
    mq.addEventListener('change', onMediaChange)
  })

  onUnmounted(() => {
    mq?.removeEventListener('change', onMediaChange)
  })

  const showWorkPanel = computed(() => {
    if (_manualOverride.value !== null) return _manualOverride.value
    return isWideScreen.value
  })

  function toggleWorkPanel() {
    _manualOverride.value = !showWorkPanel.value
  }

  return { isWideScreen, showWorkPanel, toggleWorkPanel }
}
