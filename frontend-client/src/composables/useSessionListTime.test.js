import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSessionTime } from './useSessionListTime.js';

test('formatSessionTime formats today by minute and hour', () => {
  const now = new Date(2026, 6, 26, 15, 30, 0);
  assert.equal(formatSessionTime(new Date(2026, 6, 26, 15, 29, 30), now), '刚刚');
  assert.equal(formatSessionTime(new Date(2026, 6, 26, 15, 18, 0), now), '12分钟前');
  assert.equal(formatSessionTime(new Date(2026, 6, 26, 12, 0, 0), now), '3小时前');
  assert.equal(formatSessionTime(new Date(2026, 6, 26, 16, 0, 0), now), '刚刚');
});

test('formatSessionTime uses natural-day boundaries', () => {
  const now = new Date(2026, 6, 26, 0, 3, 0);
  assert.equal(formatSessionTime(new Date(2026, 6, 25, 23, 59, 0), now), '昨天');
  assert.equal(formatSessionTime(new Date(2026, 6, 24, 23, 59, 0), now), '7月24日');
});

test('formatSessionTime formats same-year and cross-year dates', () => {
  const now = new Date(2026, 0, 2, 12, 0, 0);
  assert.equal(formatSessionTime(new Date(2025, 11, 31, 12, 0, 0), now), '2025-12-31');
  assert.equal(formatSessionTime(new Date(2026, 0, 1, 12, 0, 0), now), '昨天');
});

test('formatSessionTime returns empty text for invalid values', () => {
  assert.equal(formatSessionTime('not-a-date', new Date()), '');
  assert.equal(formatSessionTime(new Date(), 'not-a-date'), '');
});
