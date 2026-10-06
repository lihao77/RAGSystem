import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMissingBackendChecks } from './check-ci-backend-coverage.mjs';

const pkg = { name: '@ragsystem/backend-plugin-example', scripts: { typecheck: 'tsc', build: 'tsc', test: 'node --test' } };
const scripts = {
  'typecheck:backend': `npm -w ${pkg.name} run typecheck`,
  'build:backend': `npm -w ${pkg.name} run build`,
  'check:backend': `npm -w ${pkg.name} run typecheck && npm -w ${pkg.name} run build && npm -w ${pkg.name} test`,
};

test('accepts both npm test and npm run test in complete gates', () => {
  assert.deepEqual(findMissingBackendChecks(scripts, [pkg]), []);
  assert.deepEqual(findMissingBackendChecks({
    ...scripts, 'check:backend': scripts['check:backend'].replace(`${pkg.name} test`, `${pkg.name} run test`),
  }, [pkg]), []);
});

test('a new backend plugin must join every gate', () => {
  const added = { ...pkg, name: '@ragsystem/backend-plugin-new' };
  const missing = findMissingBackendChecks(scripts, [pkg, added]);
  assert.equal(missing.length, 5);
  assert.ok(missing.every((message) => message.includes(added.name)));
});

test('detects an omitted runtime test without matching similarly named packages', () => {
  const changed = { ...scripts, 'check:backend': scripts['check:backend'].replace(`${pkg.name} test`, `${pkg.name}-other test`) };
  assert.deepEqual(findMissingBackendChecks(changed, [pkg]), [`check:backend does not run ${pkg.name} test`]);
});

test('a backend package cannot silently remove its test script', () => {
  assert.deepEqual(findMissingBackendChecks(scripts, [{ ...pkg, scripts: { typecheck: 'tsc', build: 'tsc' } }]), [`${pkg.name} has no test script`]);
});
