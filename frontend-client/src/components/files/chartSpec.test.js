import assert from 'node:assert/strict';
import test from 'node:test';

import { SERIES_TYPE_WHITELIST, parseChartSpec } from './chartSpec.js';

const BASE_OPTION = {
  xAxis: { type: 'category', data: ['一', '二', '三'] },
  yAxis: { type: 'value' },
  series: [{ type: 'line', name: '水位', data: [1, 2, 3] }],
};

test('parseChartSpec 接受裸 option 对象', () => {
  const result = parseChartSpec(JSON.stringify(BASE_OPTION));
  assert.equal(result.ok, true);
  assert.deepEqual(result.option.series, BASE_OPTION.series);
});

test('parseChartSpec 解包 renderer 包装并保留净化后的 option', () => {
  const result = parseChartSpec(JSON.stringify({
    renderer: 'echarts',
    version: 1,
    option: { ...BASE_OPTION, title: { text: '趋势' } },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.option.title.text, '趋势');
  assert.equal('renderer' in result.option, false);
});

test('parseChartSpec 拒绝不支持的 renderer', () => {
  const result = parseChartSpec(JSON.stringify({ renderer: 'plotly', option: BASE_OPTION }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /plotly/);
});

test('parseChartSpec 拒绝非法 JSON / 非对象顶层 / 缺 series', () => {
  assert.equal(parseChartSpec('{oops').ok, false);
  assert.equal(parseChartSpec('[1,2]').ok, false);
  assert.equal(parseChartSpec('{"tooltip":{}}').ok, false);
});

test('series 类型白名单过滤未注册的图表类型', () => {
  const option = {
    series: [
      { type: 'bar', data: [1] },
      { type: 'radar', data: [2] },
      { data: [3] },
    ],
  };
  const result = parseChartSpec(JSON.stringify(option));
  assert.equal(result.ok, true);
  assert.deepEqual(result.option.series, [{ type: 'bar', data: [1] }]);
  assert.ok(SERIES_TYPE_WHITELIST.includes('bar'));
});

test('全部 series 被过滤时拒绝', () => {
  const result = parseChartSpec(JSON.stringify({ series: [{ type: 'treemap', data: [1] }] }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /series/);
});

test('字符串中的 HTML 标记被转义，防 tooltip/label 注入', () => {
  const option = {
    series: [{
      type: 'line',
      name: '<img src=x onerror=alert(1)>',
      data: [{ value: 1, name: '站点<script>' }],
    }],
  };
  const result = parseChartSpec(JSON.stringify(option));
  assert.equal(result.ok, true);
  // 净化只转义 `<`（注入必需字符），`>` 原样保留
  assert.equal(result.option.series[0].name, '&lt;img src=x onerror=alert(1)>');
  assert.equal(result.option.series[0].data[0].name, '站点&lt;script>');
});

test('链接类键只放行 http(s)', () => {
  const option = {
    series: [{
      type: 'pie',
      data: [
        { value: 1, name: 'a', link: 'javascript:alert(1)' },
        { value: 2, name: 'b', link: 'https://example.com' },
      ],
    }],
  };
  const result = parseChartSpec(JSON.stringify(option));
  assert.equal(result.ok, true);
  assert.equal('link' in result.option.series[0].data[0], false);
  assert.equal(result.option.series[0].data[1].link, 'https://example.com');
});

test('深度超出上限的子树被剔除，节点数超预算整体拒绝', () => {
  let deep = { value: 1 };
  for (let i = 0; i < 40; i += 1) deep = { nested: deep };
  const deepOption = { ...BASE_OPTION, tooltip: deep };
  assert.equal(parseChartSpec(JSON.stringify(deepOption)).ok, true); // 深层被 DROP 而非整体失败

  // 预算只计结构节点（对象/数组），原始值数组不触发；对象数组才计入
  const wide = { series: [{ type: 'bar', data: new Array(25000).fill(0).map(() => ({ value: 1 })) }] };
  const budget = parseChartSpec(JSON.stringify(wide));
  assert.equal(budget.ok, false);
  assert.match(budget.reason, /规模上限/);
});

test('number 溢出（1e999 → Infinity）被剔除', () => {
  // JSON.stringify 序列化不了 Infinity，必须用原始文本构造
  const result = parseChartSpec('{"series":[{"type":"bar","data":[1e999,2]}]}');
  assert.equal(result.ok, true);
  assert.deepEqual(result.option.series[0].data, [2]);
});
