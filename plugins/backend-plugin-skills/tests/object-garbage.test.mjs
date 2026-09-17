import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { SaaSSkillPackageStore } from '../dist/storage/postgres/package-store.js';
import { PostgresSkillPackageRepository } from '../dist/storage/postgres/package-repository.js';
import { createPostgresSkillsRuntimeFactory } from '../dist/storage/postgres/runtime.js';
import { validateSkillBundle } from '../dist/contracts/skills/skill-bundle.js';
import { skillPostgresExecutor } from './helpers/skill-postgres-executor.mjs';

const bundle = text => validateSkillBundle('example', [
  { relativePath: 'SKILL.md', body: Buffer.from(`---\nname: example\ndescription: Example\n---\n${text}\n`) },
  { relativePath: 'scripts/check.py', body: Buffer.from(`print('${text}')`) },
]);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-garbage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = skillPostgresExecutor(), objects = new Map();
  let failDelete = false, getHook, putHook, instance = 0;
  const storage = {
    async put(key, body) { objects.set(key, Buffer.from(body)); await putHook?.(key); },
    async get(key) { await getHook?.(key); return objects.has(key) ? { body: objects.get(key), metadata: {} } : null; },
    async delete(key) { if (failDelete) throw new Error('temporary object storage failure'); return objects.delete(key); },
  };
  const store = (tenant = 'tenant-a') => new SaaSSkillPackageStore(tenant, new PostgresSkillPackageRepository(db.executor), storage, path.join(root, String(++instance)));
  return { root, db, objects, storage, store, failDelete: value => { failDelete = value; },
    onGet: hook => { getHook = hook; }, onPut: hook => { putHook = hook; } };
}

test('a cold reader keeps its entire version while consecutive saves wait for it', async (t) => {
  const f = fixture(t), writer = f.store(), reader = f.store();
  await writer.createBundle(bundle('A'));
  const revision = (await writer.readBundle('example')).revision;
  const oldKeys = [...f.objects.keys()];
  const entered = deferred(), release = deferred(), uploaded = deferred();
  f.onGet(async key => { if (key === oldKeys[0]) { entered.resolve(); await release.promise; } });
  f.onPut(key => { if (key.endsWith('check.py')) uploaded.resolve(); });
  t.after(() => release.resolve());
  const reading = reader.get('example');
  await entered.promise;
  let saved = false;
  const writing = writer.saveBundle(bundle('B'), revision).then(() => { saved = true; });
  await uploaded.promise; await setImmediate();
  assert.equal(saved, false);
  assert.ok(oldKeys.every(key => f.objects.has(key)));
  release.resolve();
  const record = await reading;
  await writing;
  await writer.saveBundle(bundle('C'), (await writer.readBundle('example')).revision);
  assert.match(fs.readFileSync(path.join(record.skillDir, 'scripts/check.py'), 'utf8'), /'A'/);
  assert.ok(oldKeys.every(key => !f.objects.has(key)));
  assert.match((await writer.readBundle('example')).bundle.content, /C/);
});

test('deleting a Skill waits for an active bundle download', async (t) => {
  const f = fixture(t), writer = f.store(), reader = f.store();
  await writer.createBundle(bundle('A'));
  const revision = (await writer.readBundle('example')).revision;
  const entered = deferred(), release = deferred();
  f.onGet(async () => { entered.resolve(); await release.promise; });
  t.after(() => release.resolve());
  const reading = reader.readBundle('example');
  await entered.promise;
  let deleted = false;
  const deleting = writer.delete('example', revision).then(() => { deleted = true; });
  await setImmediate(); assert.equal(deleted, false);
  release.resolve();
  assert.equal((await reading).bundle.files.length, 2);
  await deleting;
  assert.equal(f.objects.size, 0);
  assert.equal(await reader.readBundle('example'), null);
});

test('failed deletion stays durable across store restart and final Skill deletion', async (t) => {
  const f = fixture(t), first = f.store();
  await first.createBundle(bundle('A'));
  f.failDelete(true);
  await first.saveBundle(bundle('B'), (await first.readBundle('example')).revision);
  assert.equal(f.db.data().garbage.size, 2);
  const restarted = f.store();
  await restarted.delete('example', (await restarted.readBundle('example')).revision);
  assert.equal(f.db.data().garbage.size, 4);
  assert.equal(f.objects.size, 4);
  f.failDelete(false);
  await f.store().reclaimGarbage();
  assert.equal(f.objects.size, 0);
  assert.equal(f.db.data().garbage.size, 0);
});

test('rollback never queues live files; a crash after object deletion retries idempotently', async (t) => {
  const f = fixture(t), store = f.store();
  await store.createBundle(bundle('A'));
  const before = await store.readBundle('example');
  f.db.failOnce(sql => sql.startsWith('INSERT INTO saas_skill_package_files'));
  await assert.rejects(store.saveBundle(bundle('B'), before.revision), /simulated SQL failure/);
  assert.deepEqual(await store.readBundle('example'), before);
  assert.equal(f.db.data().garbage.size, 0);
  // The B upload had an ambiguous transaction result and is conservatively retained.
  const orphanKeys = [...f.objects.keys()].filter(key => ![...f.db.data().files.values()].flat().some(file => file.object_key === key));
  const repo = new PostgresSkillPackageRepository(f.db.executor);
  await repo.enqueueGarbage('tenant-a', orphanKeys);
  f.db.failOnce(sql => sql.startsWith('DELETE FROM saas_skill_object_garbage'));
  await store.reclaimGarbage();
  assert.equal(f.db.data().garbage.size, 2);
  await f.store().reclaimGarbage();
  assert.equal(f.db.data().garbage.size, 0);
  assert.deepEqual(await store.readBundle('example'), before);
});

test('garbage is tenant scoped and a failed batch does not starve later keys', async (t) => {
  const f = fixture(t), repo = new PostgresSkillPackageRepository(f.db.executor);
  const keys = Array.from({ length: 257 }, (_, i) => `object-${String(i).padStart(3, '0')}`);
  await repo.enqueueGarbage('tenant-a', keys);
  await repo.enqueueGarbage('tenant-b', ['foreign']);
  for (const key of [...keys, 'foreign']) f.objects.set(key, Buffer.from('x'));
  await repo.reclaimGarbage('tenant-a', async key => { if (key !== keys.at(-1)) throw new Error('failed'); f.objects.delete(key); });
  await repo.reclaimGarbage('tenant-a', async key => { if (key !== keys.at(-1)) throw new Error('failed'); f.objects.delete(key); });
  assert.equal(f.objects.has(keys.at(-1)), false);
  await f.store().reclaimGarbage();
  assert.deepEqual([...f.objects.keys()], ['foreign']);
  await f.store('tenant-b').reclaimGarbage();
  assert.equal(f.objects.size, 0);
});

test('lost commit acknowledgement still preserves both the live bundle and its durable cleanup', async (t) => {
  const f = fixture(t), store = f.store();
  await store.createBundle(bundle('A'));
  const oldKeys = [...f.objects.keys()];
  f.failDelete(true);
  f.db.loseAcknowledgementOnce(sql => sql.startsWith('UPDATE saas_skill_packages'));
  await store.saveBundle(bundle('B'), (await store.readBundle('example')).revision);
  assert.equal(f.db.data().garbage.size, 2);
  assert.match((await store.readBundle('example')).bundle.content, /B/);
  f.failDelete(false);
  await f.store().reclaimGarbage();
  assert.ok(oldKeys.every(key => !f.objects.has(key)));
  assert.match((await store.readBundle('example')).bundle.content, /B/);
});

test('runtime resumes pending deletions at startup, retries periodically and stops on disposal', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t), store = f.store();
  await store.createBundle(bundle('A'));
  f.failDelete(true);
  await store.delete('example', (await store.readBundle('example')).revision);
  const factory = createPostgresSkillsRuntimeFactory({ executor: f.db.executor, objects: f.storage });
  const runtime = await factory({ deploymentKind: 'saas', tenantId: 'tenant-a', dataRoot: f.root, backgroundTasks: {}, clientEvents: {} });
  t.after(() => runtime.dispose());
  await setImmediate();
  assert.equal(f.db.data().garbage.size, 2);
  f.failDelete(false);
  t.mock.timers.tick(60_000); await setImmediate();
  assert.equal(f.objects.size, 0);
  const repo = new PostgresSkillPackageRepository(f.db.executor);
  f.objects.set('restart', Buffer.from('x')); await repo.enqueueGarbage('tenant-a', ['restart']);
  const second = await factory({ deploymentKind: 'saas', tenantId: 'tenant-a', dataRoot: f.root, backgroundTasks: {}, clientEvents: {} });
  t.after(() => second.dispose());
  await setImmediate();
  assert.equal(f.objects.size, 0, 'startup drains without a new save');
  runtime.dispose(); second.dispose();
  const count = f.db.statements.length;
  t.mock.timers.tick(60_000); await setImmediate();
  assert.equal(f.db.statements.length, count);
});
