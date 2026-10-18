/**
 * 流式追加最多每 80ms 解析一次；首段、替换、停止和终态同步刷新。
 * 只延迟展示层，原始消息内容与执行事件仍即时更新。
 */
export function createStreamingMarkdownRenderer({
  render, publish, intervalMs = 80,
  now = () => performance.now(), schedule = setTimeout, cancel = clearTimeout,
}) {
  let timer = null;
  let pending = null;
  let previous = null;
  let rendered = null;
  let renderedAt = -Infinity;
  let disposed = false;

  const cancelPending = () => {
    if (timer !== null) cancel(timer);
    timer = null;
    pending = null;
  };
  const flush = () => {
    const next = pending;
    cancelPending();
    if (disposed || !next) return;
    const html = render(next.content, { streaming: next.streaming });
    rendered = next;
    renderedAt = now();
    publish(html);
  };
  const update = (content, streaming) => {
    if (disposed) return;
    const next = { content: typeof content === 'string' ? content : '', streaming: Boolean(streaming) };
    if (previous?.content === next.content && previous.streaming === next.streaming) return;
    const appending = previous?.streaming && next.streaming && next.content.startsWith(previous.content);
    previous = next;
    pending = next;
    const delay = intervalMs - (now() - renderedAt);
    if (!appending || !rendered?.content || delay <= 0) {
      flush();
    } else if (timer === null) {
      timer = schedule(flush, delay);
    }
  };
  const dispose = () => { disposed = true; cancelPending(); };
  return { update, dispose };
}
