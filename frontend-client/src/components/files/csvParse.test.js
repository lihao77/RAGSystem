import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCsvTable, parseDelimited } from './csvParse.js';

test('parseDelimited 解析基本 CSV', () => {
  const { rows, complete } = parseDelimited('a,b,c\n1,2,3\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.equal(complete, true);
});

test('parseDelimited 处理引号内的分隔符、换行与转义引号', () => {
  const csv = 'name,note\n"Zhang, San","line1\nline2"\n"he said ""hi""",ok';
  const { rows } = parseDelimited(csv);
  assert.deepEqual(rows, [
    ['name', 'note'],
    ['Zhang, San', 'line1\nline2'],
    ['he said "hi"', 'ok'],
  ]);
});

test('parseDelimited 兼容 \\r\\n 与空行', () => {
  const { rows } = parseDelimited('h1,h2\r\n\r\nv1,v2\r\n');
  assert.deepEqual(rows, [['h1', 'h2'], ['v1', 'v2']]);
});

test('parseDelimited 支持 TSV 分隔符', () => {
  const { rows } = parseDelimited('a\tb\n1\t2', '\t');
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']]);
});

test('parseDelimited 截断文本中引号未闭合时 complete=false', () => {
  const { rows, complete } = parseDelimited('a,b\n"unterminated');
  // 原始解析保留未闭合行，由 parseCsvTable 负责丢弃
  assert.equal(complete, false);
  assert.deepEqual(rows, [['a', 'b'], ['unterminated']]);
});

test('parseCsvTable 首行作表头并统计行列', () => {
  const table = parseCsvTable('x,y\n1,2\n3,4\n5,6');
  assert.deepEqual(table.headers, ['x', 'y']);
  assert.equal(table.totalRows, 3);
  assert.equal(table.shownRows, 3);
  assert.equal(table.truncated, false);
});

test('parseCsvTable maxRows 截断并标记', () => {
  const table = parseCsvTable('x\n1\n2\n3', { maxRows: 2 });
  assert.equal(table.shownRows, 2);
  assert.equal(table.totalRows, 3);
  assert.equal(table.truncated, true);
});

test('parseCsvTable 文本截断导致不完整时丢弃末行', () => {
  const table = parseCsvTable('x,y\n1,2\n"broken', { maxRows: 10 });
  assert.deepEqual(table.rows, [['1', '2']]);
  assert.equal(table.truncated, true);
});

test('parseCsvTable 空文本返回空结构', () => {
  const table = parseCsvTable('');
  assert.deepEqual(table.headers, []);
  assert.deepEqual(table.rows, []);
  assert.equal(table.totalRows, 0);
});
