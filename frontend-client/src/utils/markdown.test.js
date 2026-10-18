import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCodeBlock, renderMarkdown } from './markdown.js';

test('代码围栏语言名中的 HTML 只能作为文本展示', () => {
  const language = '<svg/onload=globalThis.__markdownProbe=1>';
  const html = renderMarkdown(`\`\`\`${language}\nhello\n\`\`\``);
  assert.ok(!html.includes(language));
  assert.ok(html.includes('&lt;svg/onload=globalThis.__markdownProbe=1&gt;'));
  assert.ok(html.includes('aria-label="复制&lt;svg/onload=globalThis.__markdownProbe=1&gt;"'));
});

test('代码预览语言名不能逃出复制按钮的属性', () => {
  const html = renderCodeBlock('<img src=x onerror=alert(1)>', 'x" autofocus onfocus="alert(1)<>&');
  assert.ok(html.includes('aria-label="复制x&quot; autofocus onfocus=&quot;alert(1)&lt;&gt;&amp;"'));
  assert.ok(!html.includes('aria-label="复制x"'));
  assert.ok(!html.includes('<img src=x'));
});

test('正常代码高亮与复制内容不被标题转义破坏', () => {
  const code = 'const text = "中文<&>";\n';
  const html = renderCodeBlock(code, 'javascript');
  assert.ok(html.includes('<span class="md-block-title">javascript</span>'));
  assert.ok(html.includes('hljs-keyword'));
  const encoded = /data-copy-content="([^"]*)"/.exec(html)?.[1];
  assert.equal(decodeURIComponent(encoded), code);
  const other = renderMarkdown('> 引用\n\n| A |\n| --- |\n| B |');
  assert.ok(other.includes('aria-label="复制引用"'));
  assert.ok(other.includes('aria-label="复制表格"'));
});
