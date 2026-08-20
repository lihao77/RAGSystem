import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BINARY_PREVIEW_LIMIT,
  CSV_DIALOG_ROWS,
  CSV_INLINE_ROWS,
  EXTENSION_MIME_MAP,
  JSON_PRETTY_LIMIT,
  TEXT_PREVIEW_LIMIT,
  categorizeFile,
  correctMimeType,
  getFileExtension,
} from './fileCategorize.js';

test('getFileExtension 处理路径分隔符、点文件与无扩展名', () => {
  assert.equal(getFileExtension('results/report.PY'), 'py');
  assert.equal(getFileExtension('a\\b\\c.png'), 'png');
  assert.equal(getFileExtension('.env'), 'env');
  assert.equal(getFileExtension('README'), '');
  assert.equal(getFileExtension('archive.tar.'), '');
  assert.equal(getFileExtension(''), '');
});

test('categorizeFile 按扩展名归类常见文件', () => {
  assert.equal(categorizeFile('img/photo.png').category, 'image');
  assert.equal(categorizeFile('notes/README.md').category, 'markdown');
  assert.equal(categorizeFile('data/export.csv').category, 'csv');
  assert.equal(categorizeFile('data/map.geojson').category, 'json');
  assert.equal(categorizeFile('report/final.pdf').category, 'pdf');
  assert.equal(categorizeFile('site/index.html').category, 'html');
  assert.equal(categorizeFile('audio/demo.mp3').category, 'audio');
  assert.equal(categorizeFile('video/clip.webm').category, 'video');
  assert.equal(categorizeFile('script/tool.py').category, 'code');
  assert.equal(categorizeFile('app.log').category, 'code');
  assert.equal(categorizeFile('archive.bin').category, 'other');
});

test('categorizeFile 为代码类给出已注册的 hljs 语言', () => {
  assert.equal(categorizeFile('main.py').language, 'python');
  assert.equal(categorizeFile('app.tsx').language, 'typescript');
  assert.equal(categorizeFile('deploy.sh').language, 'bash');
  assert.equal(categorizeFile('conf/app.toml').language, 'ini');
  assert.equal(categorizeFile('server.log').language, '');
  // 未注册语言的扩展名无法安全判定为文本，保守归入 other
  assert.equal(categorizeFile('script.lua').category, 'other');
  // 但服务端给出 text/* 时可按 mime 兜底为代码
  assert.equal(categorizeFile('script.lua', 'text/plain').category, 'code');
});

test('categorizeFile 扩展名认不出时按 content-type 兜底', () => {
  assert.equal(categorizeFile('datafile', 'image/png').category, 'image');
  assert.equal(categorizeFile('datafile', 'application/pdf').category, 'pdf');
  assert.equal(categorizeFile('datafile', 'text/x-python').category, 'code');
  assert.equal(categorizeFile('datafile', 'application/octet-stream').category, 'other');
  assert.equal(categorizeFile('datafile', '').category, 'other');
});

test('categorizeFile label 与 delimiter', () => {
  assert.equal(categorizeFile('a.csv').delimiter, ',');
  assert.equal(categorizeFile('a.tsv').delimiter, '\t');
  assert.equal(categorizeFile('a.md').label, 'Markdown');
  assert.equal(categorizeFile('a.png').label, '图片');
  assert.equal(categorizeFile('a.py').label, 'python 代码');
  assert.equal(categorizeFile('a.log').label, '代码');
});

test('correctMimeType 修正 octet-stream 并保留服务端正确类型', () => {
  assert.equal(correctMimeType('application/octet-stream', 'report.pdf'), 'application/pdf');
  assert.equal(correctMimeType('', 'clip.webm'), 'video/webm');
  assert.equal(correctMimeType('text/plain; charset=utf-8', 'a.csv'), 'text/plain');
  assert.equal(correctMimeType('application/octet-stream', 'unknown.bin'), 'application/octet-stream');
});

test('展示上限常量符合约定', () => {
  assert.equal(TEXT_PREVIEW_LIMIT, 512 * 1024);
  assert.equal(JSON_PRETTY_LIMIT, 2 * 1024 * 1024);
  assert.equal(CSV_INLINE_ROWS, 10);
  assert.equal(CSV_DIALOG_ROWS, 1000);
  assert.equal(BINARY_PREVIEW_LIMIT, 32 * 1024 * 1024);
  // 扩展名 mime 表覆盖关键类型
  assert.equal(EXTENSION_MIME_MAP.pdf, 'application/pdf');
  assert.equal(EXTENSION_MIME_MAP.mp4, 'video/mp4');
});

test('categorizeFile 识别交互图表（.echarts 与 .echarts.json）', () => {
  assert.equal(categorizeFile('charts/trend.echarts').category, 'chart');
  assert.equal(categorizeFile('charts/trend.echarts.json').category, 'chart');
  assert.equal(categorizeFile('charts\\水位趋势.ECHARTS.json').category, 'chart');
  assert.equal(categorizeFile('charts/trend.echarts').label, '图表');
  // 普通 json 仍是 json 类别，不受影响
  assert.equal(categorizeFile('data/metrics.json').category, 'json');
  assert.equal(categorizeFile('data/echarts.json').category, 'json');
  assert.equal(correctMimeType('application/octet-stream', 'charts/trend.echarts'), 'application/json');
});
