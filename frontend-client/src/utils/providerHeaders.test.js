import test from 'node:test';
import assert from 'node:assert/strict';

import { headerObjectFromRows, headerRowsFromObject } from './providerHeaders.js';

test('headerRowsFromObject：对象→行（顺序保留），非对象按无头处理', () => {
  assert.deepEqual(
    headerRowsFromObject({ 'x-opencode-session': '{session_id}', session_id: 'static' }),
    [{ name: 'x-opencode-session', value: '{session_id}' }, { name: 'session_id', value: 'static' }],
  );
  assert.deepEqual(headerRowsFromObject(undefined), []);
  assert.deepEqual(headerRowsFromObject(null), []);
  assert.deepEqual(headerRowsFromObject('x-a: 1'), []);
  assert.deepEqual(headerRowsFromObject([['x-a', '1']]), []);
});

test('headerObjectFromRows：名称 trim 非空才收、值原样、占位符透传', () => {
  assert.deepEqual(
    headerObjectFromRows([
      { name: '  x-opencode-session  ', value: '{session_id}' },
      { name: '', value: 'dropped' },
      { name: '   ', value: 'dropped' },
      { name: 'x-static', value: 'tag' },
    ]),
    { 'x-opencode-session': '{session_id}', 'x-static': 'tag' },
  );
});

test('headerObjectFromRows：无有效行 → undefined（payload 剥键 = 清空）', () => {
  assert.equal(headerObjectFromRows([]), undefined);
  assert.equal(headerObjectFromRows([{ name: ' ', value: '1' }]), undefined);
  assert.equal(headerObjectFromRows(undefined), undefined);
  assert.equal(headerObjectFromRows(null), undefined);
});

test('行 ↔ 对象往返：键序与值不变', () => {
  const headers = { 'x-opencode-session': '{session_id}', 'X-Gateway-Tag': 'ragsystem' };
  assert.deepEqual(headerObjectFromRows(headerRowsFromObject(headers)), headers);
});
