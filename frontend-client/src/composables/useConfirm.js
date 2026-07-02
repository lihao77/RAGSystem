import { reactive } from 'vue';

/**
 * 全局确认弹窗单例。所有调用方共享同一份状态,渲染宿主 GlobalConfirmDialog.vue 挂在 App 根。
 *
 * 用法:
 *   const { confirm } = useConfirm();
 *   const ok = await confirm({ title, message, confirmText, danger });
 *   if (!ok) return;
 *
 * 对称 useToast —— 让 composable / 业务函数也能直接弹确认,而不必依赖某页面的 ref。
 * 取代了过去 `<ConfirmDialog ref="..." />` + ref.show() 的页面级模式与散落的 window.confirm。
 */
const state = reactive({
  visible: false,
  title: '确认操作',
  message: '',
  confirmText: '确定',
  cancelText: '取消',
  danger: true,
  _resolve: null,
});

function settle(value) {
  state.visible = false;
  if (state._resolve) {
    const resolve = state._resolve;
    state._resolve = null;
    resolve(value);
  }
}

/**
 * 弹出确认框,返回 Promise<boolean>;用户点确认 Resolve(true),取消/点外/ESC Resolve(false)。
 * @param {Object|string} options - 字符串时作为 message
 * @param {string} [options.title='确认操作']
 * @param {string} options.message
 * @param {string} [options.confirmText='确定']
 * @param {string} [options.cancelText='取消']
 * @param {boolean} [options.danger=true] - 危险操作时确认键置红
 */
function confirm(options = {}) {
  const opts = typeof options === 'string' ? { message: options } : options;
  state.title = opts.title ?? '确认操作';
  state.message = opts.message ?? '';
  state.confirmText = opts.confirmText ?? '确定';
  state.cancelText = opts.cancelText ?? '取消';
  state.danger = opts.danger ?? true;
  state.visible = true;
  return new Promise((resolve) => {
    state._resolve = resolve;
  });
}

export function useConfirm() {
  return {
    state,
    confirm,
    accept: () => settle(true),
    cancel: () => settle(false),
  };
}
