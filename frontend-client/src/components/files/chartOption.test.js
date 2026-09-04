import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChartOption, mergeAxisConfig } from './chartOption.js';

const TOKENS = {
  textSecondary: '#aaaaaa',
  textPrimary: '#ffffff',
  textMuted: '#666666',
  bgElevated: '#222222',
  border: '#444444'
};

const AXIS_COLORS = {
  axisLine: TOKENS.textMuted,
  axisLabel: TOKENS.textSecondary,
  splitLine: TOKENS.border
};

// 回归背景：双 Y 轴图的 yAxis 是数组，曾被对象展开成 { "0": …, "1": …, length: 2, … }，
// ECharts 解析出畸形单轴后 series 的 yAxisIndex 找不到轴模型，抛 `yAxis "N" not found` 卡死页面
const DUAL_YAXIS_OPTION = {
  xAxis: { type: 'category', data: ['2025-09', '2025-10'] },
  yAxis: [
    { type: 'value', name: '项目数', position: 'left' },
    { type: 'value', name: '金额（万元）', position: 'right' }
  ],
  series: [
    { name: '项目数', type: 'bar', data: [4, 5] },
    { name: '金额(万元)', type: 'line', yAxisIndex: 1, data: [4148.5, 770.04] }
  ]
};

test('mergeAxisConfig 数组形态保持数组，逐轴注入主题色', () => {
  const merged = mergeAxisConfig(DUAL_YAXIS_OPTION.yAxis, AXIS_COLORS);
  assert.equal(Array.isArray(merged), true);
  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((axis) => axis.name),
    ['项目数', '金额（万元）'],
  );
  for (const axis of merged) {
    assert.equal(axis.axisLine.lineStyle.color, TOKENS.textMuted);
    assert.equal(axis.axisLabel.color, TOKENS.textSecondary);
    assert.equal(axis.splitLine.lineStyle.color, TOKENS.border);
    assert.equal('length' in axis, false);
  }
});

test('mergeAxisConfig 单对象形态保持对象且注入主题色', () => {
  const merged = mergeAxisConfig({ type: 'value', name: '数值' }, AXIS_COLORS);
  assert.equal(Array.isArray(merged), false);
  assert.equal(merged.type, 'value');
  assert.equal(merged.axisLine.lineStyle.color, TOKENS.textMuted);
  assert.equal(merged.axisLabel.color, TOKENS.textSecondary);
});

test('mergeAxisConfig 用户轴配置覆盖主题默认色', () => {
  const merged = mergeAxisConfig({
    type: 'value',
    axisLabel: { color: '#00ff00' },
    axisLine: { lineStyle: { color: '#ff0000' } },
  }, AXIS_COLORS);
  assert.equal(merged.axisLabel.color, '#00ff00');
  assert.equal(merged.axisLine.lineStyle.color, '#ff0000');
});

test('mergeAxisConfig 空值返回 undefined，非对象原样透传', () => {
  assert.equal(mergeAxisConfig(undefined, AXIS_COLORS), undefined);
  assert.equal(mergeAxisConfig(null, AXIS_COLORS), undefined);
  assert.equal(mergeAxisConfig('value', AXIS_COLORS), 'value');
});

test('buildChartOption 双 Y 轴图构建后 yAxis 仍是两元素数组', () => {
  const option = buildChartOption(DUAL_YAXIS_OPTION, TOKENS);
  assert.equal(Array.isArray(option.yAxis), true);
  assert.equal(option.yAxis.length, 2);
  assert.equal(option.series[1].yAxisIndex, 1);
  assert.equal(option.xAxis.type, 'category');
});

test('buildChartOption 数组 xAxis 同样保持数组形态', () => {
  const option = buildChartOption({
    xAxis: [
      { type: 'category', data: ['一'] },
      { type: 'value' },
    ],
    yAxis: { type: 'value' },
    series: [{ type: 'line', xAxisIndex: 1, data: [1] }],
  }, TOKENS);
  assert.equal(Array.isArray(option.xAxis), true);
  assert.equal(option.xAxis.length, 2);
  assert.equal(option.xAxis[0].axisLabel.color, TOKENS.textSecondary);
});

test('buildChartOption 空数组轴映射为空数组', () => {
  const option = buildChartOption({ yAxis: [], series: [] }, TOKENS);
  assert.deepEqual(option.yAxis, []);
});

test('buildChartOption 注入主题基础配置且用户配置优先', () => {
  // 无覆盖时注入基础主题（与用户键为浅展开合并，用户对象整体替换同键基础配置）
  const base = buildChartOption({ series: [] }, TOKENS);
  assert.equal(base.backgroundColor, 'transparent');
  assert.equal(base.textStyle.color, TOKENS.textSecondary);
  assert.equal(base.title.textStyle.color, TOKENS.textPrimary);
  assert.equal(base.tooltip.backgroundColor, TOKENS.bgElevated);

  const option = buildChartOption({
    backgroundColor: '#123456',
    tooltip: { trigger: 'axis' },
    legend: { data: ['项目数'] },
    series: [],
  }, TOKENS);
  assert.equal(option.backgroundColor, '#123456');
  assert.equal(option.tooltip.trigger, 'axis');
  assert.deepEqual(option.legend.data, ['项目数']);
});

test('buildChartOption 无轴配置时轴键为 undefined', () => {
  const option = buildChartOption({ series: [{ type: 'pie', data: [] }] }, TOKENS);
  assert.equal(option.xAxis, undefined);
  assert.equal(option.yAxis, undefined);
});
