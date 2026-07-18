import assert from 'node:assert/strict';
import test from 'node:test';

import { getFieldInputValue, normalizeFieldValue } from './schemaFormValues.js';

test('string_list fields are displayed as comma-separated text', () => {
  assert.equal(
    getFieldInputValue({ type: 'string_list' }, ['pdf', 'docx']),
    'pdf, docx',
  );
  assert.equal(getFieldInputValue({ type: 'string_list' }, []), '');
});

test('string_list input is normalized back to an array', () => {
  assert.deepEqual(
    normalizeFieldValue({ type: 'string_list' }, ' pdf, docx, , txt '),
    ['pdf', 'docx', 'txt'],
  );
  assert.deepEqual(normalizeFieldValue({ type: 'string_list' }, ''), []);
});

test('nullable select normalization is preserved', () => {
  assert.equal(normalizeFieldValue({ type: 'select', nullable: true }, ''), null);
});
