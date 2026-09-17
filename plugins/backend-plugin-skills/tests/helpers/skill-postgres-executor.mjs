import assert from 'node:assert/strict';

/** Transactional test double: durable rows outlive repository/store instances.
 * Serial transactions model the row lock; SQL assertions ensure readers request
 * FOR SHARE and writers request FOR UPDATE. Real PostgreSQL also allows parallel readers.
 */
export function skillPostgresExecutor() {
  let data = { packages: new Map(), files: new Map(), garbage: new Map() };
  let tail = Promise.resolve();
  const statements = [];
  let failure = null;
  let lostAcknowledgement = null;
  const key = (tenant, name) => JSON.stringify([tenant, name]);
  const rows = (values) => ({ rows: structuredClone(values) });
  const tx = {
    transaction: (fn) => fn(tx),
    async query(raw, args = []) {
      const sql = raw.replace(/\s+/g, ' ').trim();
      statements.push(sql);
      if (failure?.(sql)) { failure = null; throw new Error('simulated SQL failure'); }
      const id = key(args[0], args[1]);
      if (sql.startsWith('SELECT * FROM saas_skill_packages WHERE tenant_id=$1 AND')) {
        assert.match(sql, /FOR (SHARE|UPDATE)$/);
        return rows(data.packages.has(id) ? [data.packages.get(id)] : []);
      }
      if (sql.startsWith('SELECT content_hash FROM saas_skill_packages')) {
        assert.match(sql, /FOR UPDATE$/);
        return rows(data.packages.has(id) ? [data.packages.get(id)] : []);
      }
      if (sql.startsWith('SELECT * FROM saas_skill_package_files')) return rows(data.files.get(id) ?? []);
      if (sql.startsWith('INSERT INTO saas_skill_packages(') || sql.startsWith('UPDATE saas_skill_packages SET')) {
        if (sql.startsWith('INSERT') && data.packages.has(id)) throw Object.assign(new Error('duplicate'), { code: '23505' });
        const [tenant_id, skill_name, description, content, metadata, content_hash, package_prefix] = args;
        const row = { tenant_id, skill_name, description, content, metadata: JSON.parse(metadata), content_hash, package_prefix,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        data.packages.set(id, row); return rows([row]);
      }
      if (sql.startsWith('DELETE FROM saas_skill_package_files')) { data.files.delete(id); return rows([]); }
      if (sql.startsWith('INSERT INTO saas_skill_package_files(')) {
        const [tenant_id, skill_name, relative_path, object_key, content_type, size_bytes] = args;
        const row = { tenant_id, skill_name, relative_path, object_key, content_type, size_bytes, updated_at: new Date().toISOString() };
        const files = data.files.get(id) ?? [];
        files.push(row); data.files.set(id, files); return rows([row]);
      }
      if (sql.startsWith('DELETE FROM saas_skill_packages ')) {
        data.packages.delete(id); data.files.delete(id); return rows([]);
      }
      if (sql.startsWith('INSERT INTO saas_skill_object_garbage(')) {
        for (const object_key of args[1]) {
          const garbageId = key(args[0], object_key);
          if (!data.garbage.has(garbageId)) data.garbage.set(garbageId, { tenant_id: args[0], object_key, attempted_at: 0 });
        }
        return rows([]);
      }
      if (sql.startsWith('SELECT object_key FROM saas_skill_object_garbage')) {
        assert.match(sql, /WHERE tenant_id=\$1.*LIMIT 256 FOR UPDATE SKIP LOCKED$/);
        return rows([...data.garbage.values()].filter(row => row.tenant_id === args[0])
          .sort((a, b) => a.attempted_at - b.attempted_at || a.object_key.localeCompare(b.object_key)).slice(0, 256));
      }
      if (sql.startsWith('DELETE FROM saas_skill_object_garbage')) { data.garbage.delete(id); return rows([]); }
      if (sql.startsWith('UPDATE saas_skill_object_garbage')) { data.garbage.get(id).attempted_at = Date.now(); return rows([]); }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const executor = {
    async transaction(fn) {
      const before = tail; let release;
      tail = new Promise(resolve => { release = resolve; });
      await before;
      const backup = structuredClone(data);
      const start = statements.length;
      let committed = false;
      try {
        const result = await fn(tx);
        committed = true;
        if (lostAcknowledgement && statements.slice(start).some(lostAcknowledgement)) {
          lostAcknowledgement = null;
          throw new Error('lost commit acknowledgement');
        }
        return result;
      }
      catch (error) { if (!committed) data = backup; throw error; }
      finally { release(); }
    },
    query: (sql, args) => executor.transaction(tx => tx.query(sql, args)),
  };
  return { executor, statements, data: () => data, failOnce: predicate => { failure = predicate; },
    loseAcknowledgementOnce: predicate => { lostAcknowledgement = predicate; } };
}
