/**
 * 「字段 + busy + 错误」表单弹窗状态机：open/form/busy/error + show/close/submit 包装。
 * 替代各管理页手写的 visible 布尔 + open/close 函数对。
 */

import { reactive, ref } from 'vue';

export function useFormDialog(initialForm = {}, { resetOnClose = true } = {}) {
  const open = ref(false);
  const busy = ref(false);
  const error = ref('');
  const form = reactive({ ...initialForm });

  function show(patch = {}) {
    Object.assign(form, patch);
    error.value = '';
    open.value = true;
  }

  function close() {
    if (busy.value) return;
    open.value = false;
    error.value = '';
    if (resetOnClose) Object.assign(form, { ...initialForm });
  }

  /** 包一层 busy/错误处理执行提交；fn 抛错时写入 error 并保持打开。 */
  async function submit(fn) {
    if (busy.value) return;
    busy.value = true;
    error.value = '';
    try {
      await fn(form);
      open.value = false;
    } catch (err) {
      error.value = err?.message || '操作失败';
    } finally {
      busy.value = false;
    }
  }

  return { open, busy, error, form, show, close, submit };
}
