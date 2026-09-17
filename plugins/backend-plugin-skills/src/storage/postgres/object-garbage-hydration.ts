import type { SkillsPostgresExecutor } from "./executor.js";

// Permanent schema normalization: also repairs restored/partially migrated databases
// whose migration history already contains skill_object_garbage but whose table is absent.
export const SKILL_OBJECT_GARBAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS saas_skill_object_garbage (
    tenant_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, object_key)
  );
  CREATE INDEX IF NOT EXISTS saas_skill_object_garbage_attempt_idx
    ON saas_skill_object_garbage(tenant_id, attempted_at, object_key);
`;

export async function normalizeSkillObjectGarbageSchema(executor: SkillsPostgresExecutor): Promise<void> {
  await executor.query(SKILL_OBJECT_GARBAGE_SCHEMA);
}
