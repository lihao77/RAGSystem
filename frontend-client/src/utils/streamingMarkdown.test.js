import test from 'node:test';
import assert from 'node:assert/strict';
import { createStreamingMarkdownRenderer } from './streamingMarkdown.js';

function createFixture() {
  let clock = 0;
  let id = 0;
  const tasks = new Map();
  const renders = [];
  const published = [];
  const renderer = createStreamingMarkdownRenderer({
    render: (content, { streaming }) => { renders.push({ content, streaming }); return `${content}:${streaming}`; },
    publish: html => published.push(html), now: () => clock,
    schedule: (callback, delay) => { tasks.set(++id, { callback, at: clock + delay }); return id; },
    cancel: handle => tasks.delete(handle),
  });
  const advance = (ms) => {
    clock += ms;
    for (const [handle, task] of tasks) {
      if (task.at > clock) continue;
      tasks.delete(handle);
      task.callback();
    }
  };
  return { ...renderer, tasks, renders, published, advance };
}

test('首段立即显示，密集追加只在窗口末尾解析最新完整内容', () => {
  const fixture = createFixture();
  fixture.update('首段', true);
  for (let index = 1; index <= 60; index += 1) {
    fixture.advance(1);
    fixture.update(`首段${'字'.repeat(index)}`, true);
  }
  assert.equal(fixture.renders.length, 1);
  assert.equal(fixture.tasks.size, 1);
  fixture.advance(20);
  assert.deepEqual(fixture.renders.at(-1), { content: `首段${'字'.repeat(60)}`, streaming: true });
  assert.equal(fixture.renders.length, 2);
  assert.equal(fixture.tasks.size, 0);
});

test('收到终态立即发布最终文本并移除光标，旧定时器不能回写', () => {
  const fixture = createFixture();
  fixture.update('开始', true);
  fixture.advance(10);
  fixture.update('开始追加', true);
  fixture.update('最终完整文本', false);
  assert.equal(fixture.published.at(-1), '最终完整文本:false');
  const count = fixture.renders.length;
  fixture.advance(1000);
  assert.equal(fixture.renders.length, count);
});

test('仅改变 streaming 状态也会立即刷新，停止不会等待窗口结束', () => {
  const fixture = createFixture();
  fixture.update('相同文本', true);
  fixture.update('相同文本', false);
  assert.deepEqual(fixture.renders, [{ content: '相同文本', streaming: true }, { content: '相同文本', streaming: false }]);
});

test('替换、回滚与清空立即生效，第一段非空内容不被空占位延迟', () => {
  const fixture = createFixture();
  fixture.update('', true);
  fixture.update('第一段', true);
  assert.equal(fixture.published.at(-1), '第一段:true');
  fixture.update('第一段新增', true);
  fixture.update('另一条消息', true);
  assert.equal(fixture.published.at(-1), '另一条消息:true');
  fixture.update('另', true);
  assert.equal(fixture.published.at(-1), '另:true');
  fixture.update('', false);
  assert.equal(fixture.published.at(-1), ':false');
  fixture.advance(1000);
  assert.equal(fixture.published.at(-1), ':false');
});

test('历史消息去重渲染，低频流式更新不增加额外等待', () => {
  const fixture = createFixture();
  fixture.update('历史', false);
  fixture.update('历史', false);
  assert.equal(fixture.renders.length, 1);
  fixture.update('流式', true);
  fixture.advance(100);
  fixture.update('流式追加', true);
  assert.equal(fixture.published.at(-1), '流式追加:true');
  assert.equal(fixture.tasks.size, 0);
});

test('销毁时取消待更新内容，之后不再解析或发布', () => {
  const fixture = createFixture();
  fixture.update('流式', true);
  fixture.update('流式追加', true);
  fixture.dispose();
  fixture.advance(1000);
  fixture.update('晚到终态', false);
  assert.equal(fixture.tasks.size, 0);
  assert.deepEqual(fixture.published, ['流式:true']);
});

test('非法或缺失正文保持空内容语义，不触发字符串方法异常', () => {
  const fixture = createFixture();
  fixture.update('原文', true);
  for (const content of [null, undefined, 42, {}]) fixture.update(content, true);
  assert.equal(fixture.published.at(-1), ':true');
  fixture.update('恢复', true);
  assert.equal(fixture.published.at(-1), '恢复:true');
});
