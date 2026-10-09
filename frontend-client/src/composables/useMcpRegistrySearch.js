import { ref, watch } from 'vue';

function querySnapshot(query) {
  return { search: query.query, limit: query.limit, latest_only: query.latest_only };
}

function queryKey(query) {
  return JSON.stringify(querySnapshot(query));
}

function sortResults(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.name}@${item.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(b.installable === true) - Number(a.installable === true)
    || String(a.display_name || a.name || '').localeCompare(String(b.display_name || b.name || '')));
}

/** 每页结果与其查询绑定，过期请求不能覆盖最新查询或混入另一查询的翻页。 */
export function useMcpRegistrySearch({ query, fetchPage, onError }) {
  const results = ref([]);
  const nextCursor = ref('');
  const loading = ref(false);
  const loadingMore = ref(false);
  const error = ref('');
  let requestId = 0;
  let resultsKey = null;

  function invalidate() {
    requestId += 1;
    nextCursor.value = '';
    loading.value = false;
    loadingMore.value = false;
    error.value = '';
  }

  // 同步作废游标，避免输入后、防抖发起新搜索前仍能请求旧页。
  const stop = watch(() => queryKey(query), invalidate, { flush: 'sync' });

  async function run({ append = false } = {}) {
    const snapshot = querySnapshot(query);
    const key = queryKey(query);
    if (append && (loading.value || !nextCursor.value || resultsKey !== key)) return;
    const cursor = append ? nextCursor.value : '';
    const id = ++requestId;
    const isCurrent = () => id === requestId && key === queryKey(query);
    loading.value = true;
    loadingMore.value = append;
    error.value = '';
    if (!append) nextCursor.value = '';
    try {
      const response = await fetchPage({ ...snapshot, cursor });
      if (!isCurrent()) return;
      results.value = sortResults(append ? [...results.value, ...(response.data?.items || [])] : (response.data?.items || []));
      resultsKey = key;
      nextCursor.value = response.data?.next_cursor || '';
      return response;
    } catch (cause) {
      if (!isCurrent()) return;
      error.value = cause?.message || (append ? '加载更多失败' : '搜索 Registry 失败');
      onError?.(error.value);
    } finally {
      if (isCurrent()) {
        loading.value = false;
        loadingMore.value = false;
      }
    }
  }

  function dispose() { stop(); invalidate(); }
  return { results, nextCursor, loading, loadingMore, error, run, dispose };
}

/** 定时器随弹窗状态取消；手动搜索也取消待执行的自动搜索。 */
export function useMcpRegistryAutoSearch({ query, active, onSearch, delayMs = 400 }) {
  let timer = null;
  function cancel() { clearTimeout(timer); timer = null; }
  function searchNow() {
    cancel();
    if (active()) return onSearch();
  }
  const stop = watch(
    () => [query.query, query.latest_only, active()],
    ([search, latest, enabled], previous) => {
      cancel();
      if (!enabled || (search === previous[0] && latest === previous[1])) return;
      timer = setTimeout(searchNow, delayMs);
    },
    { flush: 'sync' },
  );
  function dispose() { stop(); cancel(); }
  return { searchNow, dispose };
}
