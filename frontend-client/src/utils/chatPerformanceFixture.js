import { nextTick } from 'vue';
import { useSessionRunStore } from '../stores/session-run.js';
import { createSmokeArtifactMessages } from './smokeFixtures.js';

const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0).toFixed(2));
};

/** 仅由开发态浏览器基准动态导入；不向生产页面添加调试接口。 */
export async function runChatPerformanceFixture({ messageCount = 1000, updates = 90, fullHistory = false } = {}) {
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
  if (fullHistory && messageCount >= 200) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
  // 进入消息流需要先完成空态的 out-in 过渡。
  while (!document.querySelector(`.message-stream > [data-msg-index="${messageCount - 1}"] .markdown-body`)) {
    if (performance.now() - started > 15_000) throw new Error('Performance fixture did not mount');
    await frame();
  }
  for (let index = 0; index < 8; index += 1) await frame();
  const historyMountMs = performance.now() - started;
  const container = document.querySelector('.chat-messages-wrapper');
  const input = document.querySelector('.bottom-dock textarea');
  const body = document.querySelector(`.message-stream > [data-msg-index="${messageCount - 1}"] .markdown-body`);
  if (!container || !input || !body) throw new Error('Performance fixture is missing chat controls');
  const previousScrollBehavior = container.style.scrollBehavior;
  container.style.scrollBehavior = 'auto';
  // 接近底部后向上离开，持续更新不应夺走用户正在阅读的位置。
  container.scrollTop = container.scrollHeight;
  container.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
  container.scrollTop = Math.max(0, container.scrollTop - 800);
  container.dispatchEvent(new Event('scroll'));
  for (let index = 0; index < 6; index += 1) await frame();
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
    const rows = document.querySelectorAll('.message-stream > .message');
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
  let maxMountedMessages = 0;
  let lastScrollFrame = performance.now();
  for (let index = 0; index < 30; index += 1) {
    await frame();
    const now = performance.now();
    scrollIntervals.push(now - lastScrollFrame);
    lastScrollFrame = now;
    maxMountedMessages = Math.max(maxMountedMessages, document.querySelectorAll('.message-stream > .message').length);
    container.scrollTop = (container.scrollHeight - container.clientHeight) * index / 29;
  }
  container.style.scrollBehavior = previousScrollBehavior;
  return {
    fixtureVersion: 3,
    browser: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight },
    workload: { messageCount, updates, initialMarkdownChars: source.length, codeBlocks: 100, fullHistory },
    historyMountMs: Number(historyMountMs.toFixed(2)), streamingMs: Number(streamingMs.toFixed(2)),
    frameP50Ms: percentile(intervals, 0.5), frameP95Ms: percentile(intervals, 0.95),
    inputToFrameP95Ms: percentile(inputToFrame, 0.95), markdownPublications: publications,
    scrollFrameP95Ms: percentile(scrollIntervals, 0.95),
    domNodes: document.querySelectorAll('*').length,
    mountedMessages: document.querySelectorAll('.message-stream > .message').length,
    maxMountedMessages,
    readingPositionPx: anchoredTop, anchorDriftPx, finalComplete,
  };
}

/** Development-only integration checks against the component's exposed navigation API. */
export async function verifyMessageWindowFixture() {
  const store = useSessionRunStore();
  const host = document.querySelector('.chat-messages-wrapper');
  const list = document.querySelector('.chat-messages').__vueParentComponent;
  const context = list.provides.messageContext;
  const navigate = list.exposed.scrollToMessage;
  const settle = async () => { await nextTick(); for (let i = 0; i < 10; i += 1) await frame(); };
  const check = (value, message) => { if (!value) throw new Error(`Message window: ${message}`); };
  const row = index => document.querySelector(`.message-stream > [data-msg-index="${index}"]`);
  const contentTop = index => row(index).getBoundingClientRect().top + (parseFloat(getComputedStyle(row(index)).paddingTop) || 0);
  const middle = Math.floor(store.rootMessages.length / 4) * 2;
  const last = store.rootMessages.length - 1;
  host.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));

  // The unpersisted tail slot keeps its own gap/entrance behavior in windowed mode.
  const pending = document.createElement('div');
  pending.className = 'message user pending-image-message';
  document.querySelector('.message-stream').append(pending);
  try {
    check(parseFloat(getComputedStyle(pending).marginTop) > 0 && getComputedStyle(pending).animationName !== 'none', 'pending tail spacing or entrance animation was overridden');
  } finally { pending.remove(); }

  // Stable message IDs and seq references work even when their rows are not mounted.
  await navigate(`perf-${middle}`);
  await settle();
  check(row(middle), 'offscreen ID navigation did not mount its row');
  check(Math.abs(row(middle).getBoundingClientRect().top - host.getBoundingClientRect().top) < 3, 'ID navigation missed the target');
  check(document.querySelectorAll('.message-stream > .message').length < 100, 'history was fully mounted');

  // Editing keeps the same textarea and draft while the user visits other history.
  row(middle).querySelector('[aria-label="编辑"]').click();
  await settle();
  const editor = row(middle).querySelector('textarea');
  check(editor, 'edit did not open');
  editor.value = '保留窗口外的编辑草稿';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  await navigate('seq:11');
  await settle();
  check(row(middle)?.querySelector('textarea') === editor && editor.value === '保留窗口外的编辑草稿', 'editing state was discarded offscreen');
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  editor.blur();
  await settle();
  check(!row(middle), 'cancelled editor was retained outside the window');

  // Retry must use the global predecessor, even after rows have been unmounted.
  await navigate(middle + 1);
  await settle();
  let retryTarget;
  const retry = context.rollbackAndRetry;
  try {
    context.rollbackAndRetry = message => { retryTarget = message; };
    row(middle + 1).querySelector('[aria-label="重试"]').click();
    check(retryTarget?.id === `perf-${middle}`, 'retry crossed the original message boundary');
  } finally { context.rollbackAndRetry = retry; }

  // Expanded execution details must keep their component state across disjoint windows.
  const execution = createSmokeArtifactMessages()[0];
  Object.assign(store.rootMessages[middle], {
    executionTree: execution.executionTree, has_execution: true, executionStepsLoaded: true,
  });
  await settle();
  row(middle).querySelector('.assistant-execution-toggle').click();
  await settle();
  const panel = row(middle).querySelector('.assistant-execution-list-outer');
  check(panel.classList.contains('is-open'), 'execution details did not expand');
  await navigate(10);
  await settle();
  check(row(middle)?.querySelector('.assistant-execution-list-outer') === panel && panel.classList.contains('is-open'), 'expanded execution details were discarded');
  await navigate(middle + 40);
  await settle();
  const anchor = row(middle + 40).getBoundingClientRect().top;
  const previousHeight = row(middle).getBoundingClientRect().height;
  // Grow a mounted, pinned row above the viewport; a spacer estimate alone cannot
  // satisfy this check. The current reader must retain the same screen position.
  store.rootMessages[middle].content += '\n动态高度测试。'.repeat(120);
  await settle();
  check(row(middle).getBoundingClientRect().height > previousHeight + 20, 'dynamic-height fixture did not grow');
  check(Math.abs(row(middle + 40).getBoundingClientRect().top - anchor) < 3, 'offscreen content growth displaced the reader');
  row(middle).querySelector('.assistant-execution-toggle').click();
  await settle();
  check(!row(middle), 'collapsed execution details were retained outside the window');

  // Native find switches to a complete DOM. Returning to windowing preserves the reader.
  await navigate(middle + 1);
  await settle();
  const top = contentTop(middle + 1);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
  await settle();
  check(document.querySelectorAll('.message-stream > .message').length === store.rootMessages.length, 'native find did not reveal all messages');
  check(Math.abs(contentTop(middle + 1) - top) < 3, `show-all changed the reading position: ${contentTop(middle + 1) - top}px`);
  document.querySelector('.message-window-controls button').click();
  await settle();
  check(document.querySelectorAll('.message-stream > .message').length < 100, 'windowing did not resume');
  check(Math.abs(contentTop(middle + 1) - top) < 3, `resuming windowing changed the reading position: ${contentTop(middle + 1) - top}px`);
  // New turns preserve a detached reader, then follow their growing tail after reattachment.
  const previousAnchor = contentTop(middle + 1);
  store.rootMessages.push(
    { id: 'window-new-user', seq: last + 2, role: 'user', content: '继续检查', metadata: {}, finished: true },
    { id: 'window-new-assistant', seq: last + 3, role: 'assistant', content: '正在补充检查。', metadata: {}, finished: false },
  );
  await settle();
  check(Math.abs(contentTop(middle + 1) - previousAnchor) < 3, 'new turns displaced the detached reader');
  const behavior = host.style.scrollBehavior;
  host.style.scrollBehavior = 'auto';
  host.scrollTop = host.scrollHeight;
  host.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
  host.dispatchEvent(new Event('scroll'));
  await settle();
  store.rootMessages.at(-1).content += '\n\n跟随新增内容。'.repeat(80);
  await settle();
  check(host.scrollHeight - host.scrollTop - host.clientHeight <= 3, 'stream growth stopped following the bottom');
  store.rootMessages.at(-1).finished = true;
  host.style.scrollBehavior = behavior;
  return { navigation: true, editing: true, retryBoundary: true, expandedDetails: true, dynamicHeight: true, nativeFind: true, bottomFollowing: true };
}
