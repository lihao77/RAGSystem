import { nextTick } from 'vue';
import { useSessionRunStore } from '../stores/session-run.js';

const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0).toFixed(2));
};

/** 仅由开发态浏览器基准动态导入；不向生产页面添加调试接口。 */
export async function runChatPerformanceFixture({ messageCount = 1000, updates = 90 } = {}) {
  const store = useSessionRunStore();
  const history = Array.from({ length: messageCount }, (_, index) => ({
    id: `perf-${index}`, seq: index + 1, role: index % 2 ? 'assistant' : 'user',
    content: index % 20 === 1
      ? `第 ${index} 条记录\n\n\`\`\`js\nconst station = { level: 12.4 };\n\`\`\``
      : `第 ${index} 条${index % 2 ? '回复：已完成检查。' : '请求：检查站点数据。'}`,
    finished: true, stopped: false, metadata: {}, has_execution: false,
  }));
  const source = Array.from({ length: 100 }, (_, index) =>
    `## 站点 ${index}\n\n水位检查结果与建议。\n\n\`\`\`javascript\nconst station${index} = { level: 12.4, status: "normal" };\nconsole.log(station${index});\n\`\`\`\n\n`).join('');
  const tail = history.at(-1);
  tail.content = source;
  tail.finished = false;

  const started = performance.now();
  store.rootMessages = history;
  await nextTick();
  // 进入消息流需要先完成空态的 out-in 过渡。
  while (document.querySelectorAll('.message-stream > .message').length !== messageCount) {
    if (performance.now() - started > 15_000) throw new Error('Performance fixture did not mount');
    await frame();
  }
  await frame();
  const historyMountMs = performance.now() - started;
  const container = document.querySelector('.chat-messages-wrapper');
  const input = document.querySelector('.bottom-dock textarea');
  const rows = document.querySelectorAll('.message-stream > .message');
  const body = rows[rows.length - 1].querySelector('.markdown-body');
  if (!container || !input || !body) throw new Error('Performance fixture is missing chat controls');
  const previousScrollBehavior = container.style.scrollBehavior;
  container.style.scrollBehavior = 'auto';
  // 接近底部后向上离开，持续更新不应夺走用户正在阅读的位置。
  container.scrollTop = container.scrollHeight;
  container.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
  container.scrollTop = Math.max(0, container.scrollTop - 800);
  container.dispatchEvent(new Event('scroll'));
  await frame();
  const anchoredTop = container.scrollTop;
  if (anchoredTop <= 0) throw new Error('Performance fixture did not leave the bottom for a reading position');

  let publications = 0;
  const observer = new MutationObserver(() => { publications += 1; });
  observer.observe(body, { childList: true });
  const intervals = [];
  const inputToFrame = [];
  const streamingStarted = performance.now();
  let lastFrame = streamingStarted;
  let pendingInputAt = null;
  const message = store.rootMessages.at(-1);
  for (let index = 0; index < updates; index += 1) {
    await frame();
    const now = performance.now();
    intervals.push(now - lastFrame);
    lastFrame = now;
    if (pendingInputAt !== null) { inputToFrame.push(now - pendingInputAt); pendingInputAt = null; }
    message.content += `\n增量 ${index}：检查结果已更新。`;
    // 触发真实列表的 hover 更新，覆盖历史重试关联重复求值的路径。
    rows[(index * 17) % rows.length].dispatchEvent(new MouseEvent('mouseenter'));
    if (index % 10 === 0) {
      pendingInputAt = performance.now();
      input.value = `补充要求 ${index}`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await nextTick();
  }
  message.content += '\n\n最终完整性标记：PERF_COMPLETE';
  message.finished = true;
  await nextTick();
  await frame();
  observer.disconnect();
  const streamingMs = performance.now() - streamingStarted;
  const finalComplete = body.textContent.includes('PERF_COMPLETE') && !body.querySelector('.stream-orb');
  const anchorDriftPx = Math.abs(container.scrollTop - anchoredTop);
  if (!finalComplete) throw new Error('Final streamed text was not flushed immediately');
  if (anchorDriftPx > 2) throw new Error(`Streaming displaced the reading position by ${anchorDriftPx}px`);
  const copiedCode = decodeURIComponent(body.querySelector('[data-copy-type="code"]')?.getAttribute('data-copy-content') || '');
  if (copiedCode !== 'const station0 = { level: 12.4, status: "normal" };\nconsole.log(station0);\n') {
    throw new Error('Code copy payload changed during streaming');
  }
  // 独立测量滚动，不混入流式阶段的数据；两者都只记录时序，不设易抖动的速度门槛。
  const scrollIntervals = [];
  let lastScrollFrame = performance.now();
  for (let index = 0; index < 30; index += 1) {
    await frame();
    const now = performance.now();
    scrollIntervals.push(now - lastScrollFrame);
    lastScrollFrame = now;
    container.scrollTop = (container.scrollHeight - container.clientHeight) * index / 29;
  }
  container.style.scrollBehavior = previousScrollBehavior;
  return {
    fixtureVersion: 2,
    browser: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight },
    workload: { messageCount, updates, initialMarkdownChars: source.length, codeBlocks: 100 },
    historyMountMs: Number(historyMountMs.toFixed(2)), streamingMs: Number(streamingMs.toFixed(2)),
    frameP50Ms: percentile(intervals, 0.5), frameP95Ms: percentile(intervals, 0.95),
    inputToFrameP95Ms: percentile(inputToFrame, 0.95), markdownPublications: publications,
    scrollFrameP95Ms: percentile(scrollIntervals, 0.95),
    domNodes: document.querySelectorAll('*').length, readingPositionPx: anchoredTop, anchorDriftPx, finalComplete,
  };
}
