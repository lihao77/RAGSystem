import { ref } from 'vue';
import { useAsyncAction } from './useAsyncAction.js';

function pickItems(result) {
  if (Array.isArray(result)) return result;
  if (!result) return [];
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.data)) return result.data;
  return [];
}

/**
 * 收敛"列表数据 + 加载/错误三态 + refresh"样板,配合 EntityListLayout 展示。
 *
 * 内部复用 useAsyncAction 承载 loading / error / try-catch / toast,这里只补
 * "从 fetcher 结果里挑出 items 数组"与对外 items 状态——避免与 useAsyncAction
 * 各写一份相同的加载样板。
 *
 * 错误默认不弹 toast —— 列表错误通常由 EntityListLayout 的错误态 + 重试按钮承载;
 * 需要额外 toast 时传 toastOnError: true。
 *
 * @param {Function} fetcher - 返回数组或 { items } / { data } 的异步函数
 * @param {Object} options
 * @param {boolean} [options.immediate=true] - 是否在调用时立即加载一次
 * @param {string} [options.errorPrefix='加载失败']
 * @param {boolean} [options.toastOnError=false]
 * @param {Function} [options.onSuccess] - (items, rawResult)
 * @returns {{ items, loading, error, refresh, setItems }}
 */
export function useEntityList(fetcher, options = {}) {
  const {
    immediate = true,
    errorPrefix = '加载失败',
    toastOnError = false,
    onSuccess,
  } = options;

  const items = ref([]);

  const action = useAsyncAction(
    async () => {
      const result = await fetcher();
      const next = pickItems(result);
      items.value = next;
      onSuccess?.(next, result);
      return result;
    },
    { errorPrefix, showErrorToast: toastOnError },
  );

  async function refresh() {
    const result = await action.run();
    return result === undefined ? undefined : items.value;
  }

  function setItems(next) {
    items.value = Array.isArray(next) ? next : [];
  }

  if (immediate) refresh();

  return { items, loading: action.loading, error: action.error, refresh, setItems };
}
