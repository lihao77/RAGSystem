import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SIDEBAR_OVERLAY_MAX_WIDTH, SIDEBAR_OVERLAY_QUERY } from './breakpoints.js';

// CSS 媒体查询读不到 JS 常量，两边是同值的字面量。改断点时必须一起改，
// 否则会出现「侧栏已切抽屉、布局仍按宽屏」这类只在断点附近才暴露的错位。
const STYLE_OWNERS = [
  '../styles/chat-view.css',
  '../styles/forms.css',
  '../components/PageLayout.vue',
];

test('侧栏断点在 JS 与样式表里同值', async () => {
  assert.equal(SIDEBAR_OVERLAY_MAX_WIDTH, 900);
  assert.equal(SIDEBAR_OVERLAY_QUERY, '(max-width: 900px)');

  const layout = await readFile(new URL('../layouts/MainLayout.vue', import.meta.url), 'utf8');
  // 判定必须走 matchMedia：innerWidth 含滚动条宽度，和 CSS 的基准能差几个像素
  assert.equal(layout.includes('window.matchMedia(SIDEBAR_OVERLAY_QUERY)'), true);
  assert.equal(layout.includes('isMobile.value = sidebarOverlayQuery.matches'), true);
  assert.equal(/window\.innerWidth\s*[<>]/.test(layout), false);

  for (const relative of STYLE_OWNERS) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.equal(
      source.includes(`@media ${SIDEBAR_OVERLAY_QUERY}`),
      true,
      `${relative} 应使用与 JS 同值的媒体查询 ${SIDEBAR_OVERLAY_QUERY}`,
    );
  }
});
