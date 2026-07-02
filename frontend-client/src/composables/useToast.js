import { reactive } from 'vue';

/**
 * 全局 toast 单例。所有调用方共享同一份状态,渲染宿主 GlobalToast.vue 挂在 App 根。
 *
 * 取代了过去每页 `<AppToast ref="toastRef" />` + `toastRef.value?.show(...)` 的页面级模式,
 * 让 composable(useAsyncAction 等)也能直接弹 toast,而不必依赖某页面的 ref。
 */
const state = reactive({
  visible: false,
  message: '',
  type: 'error', // 'success' | 'error' | 'warning'
  action: null,
  actionLabel: '重试',
});

let hideTimer = null;

function clearHideTimer() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function show(message, typeOrAction = 'error', actionLabel = '重试') {
  clearHideTimer();
  state.message = message;
  state.type = typeof typeOrAction === 'string' ? typeOrAction : 'error';
  state.action = typeof typeOrAction === 'function' ? typeOrAction : null;
  state.actionLabel = actionLabel;
  state.visible = true;
  hideTimer = setTimeout(() => {
    state.visible = false;
  }, 3000);
}

function hide() {
  clearHideTimer();
  state.visible = false;
}

function success(message, actionLabel) {
  show(message, 'success', actionLabel);
}

function error(message, action) {
  show(message, action || 'error');
}

function warning(message) {
  show(message, 'warning');
}

export function useToast() {
  return { state, show, hide, success, error, warning };
}
