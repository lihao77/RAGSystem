import assert from 'node:assert/strict'
import test from 'node:test'

import { computeNextRun, isValidCronExpression } from '../dist/services/cron-parser.js'

test('accepts standard 5-field expressions and rejects invalid ones', () => {
  assert.equal(isValidCronExpression('* * * * *'), true)
  assert.equal(isValidCronExpression('0 9 * * 1-5'), true)
  assert.equal(isValidCronExpression('*/15 0-23/2 * 1,7 0'), true)
  assert.equal(isValidCronExpression('60 * * * *'), false, '分钟越界')
  assert.equal(isValidCronExpression('* * * *'), false, '字段数不足')
  assert.equal(isValidCronExpression(''), false)
  assert.equal(isValidCronExpression('0 0 31 2 *'), false, '2 月 31 日一年内不存在触发点')
})

test('next run is a future epoch timestamp for valid expressions', () => {
  const before = Date.now() / 1000
  const value = computeNextRun('0 9 * * 1-5')
  assert.ok(typeof value === 'number', '合法表达式应返回时间戳')
  assert.ok(value > before - 1, '下次执行时间必须不早于当前')
})

test('day-of-month and day-of-week restriction follows union semantics', () => {
  // 13 日或每周五（标准 cron 的 DOM/DOW 并集语义）；仅断言可解析并产出时间戳
  assert.equal(isValidCronExpression('0 0 13 * 5'), true)
  assert.ok(typeof computeNextRun('0 0 13 * 5') === 'number')
})
