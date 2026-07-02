import { ref, shallowRef } from 'vue';
import { useToast } from './useToast.js';

/**
 * 收敛管理端反复出现的 CRUD 样板:
 *   loading.value = true
 *   try { await api(); toast.success(...) }
 *   catch (e) { toast.error(e.message || '失败') }
 *   finally { loading.value = false }
 *
 * @param {Function} fn - 异步动作,返回数据(成功时写入 data)
 * @param {Object} options
 * @param {string} [options.successMessage] - 成功 toast 文案;不给则不弹成功 toast
 * @param {string} [options.errorPrefix='操作失败'] - 失败兜底文案(无 e.message 时)
 * @param {boolean} [options.showErrorToast=true] - 是否弹错误 toast(列表加载走三态时可关)
 * @param {Function} [options.onSuccess] - 成功回调 (result)
 * @param {Function} [options.onError] - 失败回调 (e)
 * @returns {{ run, loading, error, data, reset }}
 */
export function useAsyncAction(fn, options = {}) {
  const {
    successMessage = '',
    errorPrefix = '操作失败',
    showErrorToast = true,
    onSuccess,
    onError,
  } = options;

  const toast = useToast();
  const loading = ref(false);
  const error = ref('');
  const data = shallowRef(null);

  async function run(...args) {
    loading.value = true;
    error.value = '';
    try {
      const result = await fn(...args);
      data.value = result;
      if (successMessage) {
        const msg = typeof successMessage === 'function' ? successMessage(result, ...args) : successMessage;
        if (msg) toast.success(msg);
      }
      onSuccess?.(result);
      return result;
    } catch (e) {
      const message = e?.message || errorPrefix;
      error.value = message;
      if (showErrorToast) toast.error(message);
      onError?.(e);
      return undefined;
    } finally {
      loading.value = false;
    }
  }

  function reset() {
    error.value = '';
    data.value = null;
  }

  return { run, loading, error, data, reset };
}
