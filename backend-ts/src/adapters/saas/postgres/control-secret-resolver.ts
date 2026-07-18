import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

import type {
  SecretCoordinates,
  SecretEnvelopeRecord,
  SecretEnvelopeRepository,
  SecretMutation,
  SecretResolver,
} from "../../../contracts/secret-resolver.js";
import { SecretIntegrityError } from "../../../contracts/secret-resolver.js";
import type { TenantId } from "../../../identity/types.js";
import { runPostgresSecretMigrations } from "./control-secret-migrations.js";

const ENVELOPE_VERSION = 1;
const NONCE_BYTES = 12;
const MASTER_KEY_BYTES = 32;

interface SecretQueryable {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
}

export class PostgresSecretEnvelopeRepository implements SecretEnvelopeRepository {
  private closed = false;

  constructor(
    readonly database: SecretQueryable,
    private readonly ownsPool = false,
  ) {}

  async get(coordinates: SecretCoordinates): Promise<SecretEnvelopeRecord | null> {
    this.assertOpen();
    const result = await this.database.query<SecretEnvelopeRow>(`
      SELECT tenant_id, purpose, resource_id, field, envelope_version,
             nonce, auth_tag, ciphertext, updated_at
      FROM control_secret_envelopes
      WHERE tenant_id=$1 AND purpose=$2 AND resource_id=$3 AND field=$4
    `, coordinateParams(coordinates));
    const row = result.rows[0];
    if (!row) return null;
    return {
      coordinates: {
        tenantId: row.tenant_id as TenantId,
        purpose: row.purpose,
        resourceId: row.resource_id,
        field: row.field,
      },
      envelopeVersion: Number(row.envelope_version),
      nonce: Buffer.from(row.nonce),
      authTag: Buffer.from(row.auth_tag),
      ciphertext: Buffer.from(row.ciphertext),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
    };
  }

  async put(record: SecretEnvelopeRecord): Promise<void> {
    this.assertOpen();
    await this.database.query(`
      INSERT INTO control_secret_envelopes(
        tenant_id, purpose, resource_id, field, envelope_version,
        nonce, auth_tag, ciphertext, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
      ON CONFLICT(tenant_id, purpose, resource_id, field) DO UPDATE SET
        envelope_version=EXCLUDED.envelope_version,
        nonce=EXCLUDED.nonce,
        auth_tag=EXCLUDED.auth_tag,
        ciphertext=EXCLUDED.ciphertext,
        updated_at=CURRENT_TIMESTAMP
    `, [
      ...coordinateParams(record.coordinates),
      record.envelopeVersion,
      record.nonce,
      record.authTag,
      record.ciphertext,
    ]);
  }

  async delete(coordinates: SecretCoordinates): Promise<boolean> {
    this.assertOpen();
    const result = await this.database.query("DELETE FROM control_secret_envelopes WHERE tenant_id=$1 AND purpose=$2 AND resource_id=$3 AND field=$4", coordinateParams(coordinates));
    return (result.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool) await (this.database as Pool).end();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("secret repository is closed");
  }
}

export class Aes256GcmSecretResolver implements SecretResolver {
  private readonly key: Buffer;
  private closed = false;

  constructor(
    private readonly repository: SecretEnvelopeRepository,
    masterKey: Uint8Array,
  ) {
    if (masterKey.byteLength !== MASTER_KEY_BYTES) {
      throw new Error(`secret master key must be exactly ${MASTER_KEY_BYTES} bytes`);
    }
    this.key = Buffer.from(masterKey);
  }

  async resolve(coordinates: SecretCoordinates): Promise<string | null> {
    this.assertOpen();
    const record = await this.repository.get(coordinates);
    if (!record) return null;
    if (record.envelopeVersion !== ENVELOPE_VERSION || !sameCoordinates(record.coordinates, coordinates)) {
      throw new SecretIntegrityError();
    }
    if (record.nonce.length !== NONCE_BYTES || record.authTag.length !== 16) {
      throw new SecretIntegrityError();
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, record.nonce);
      decipher.setAAD(aadFor(coordinates, record.envelopeVersion));
      decipher.setAuthTag(record.authTag);
      return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretIntegrityError();
    }
  }

  async mutate(coordinates: SecretCoordinates, mutation: SecretMutation): Promise<void> {
    this.assertOpen();
    if (mutation.kind === "unchanged") return;
    if (mutation.kind === "clear") {
      await this.repository.delete(coordinates);
      return;
    }
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(aadFor(coordinates, ENVELOPE_VERSION));
    const ciphertext = Buffer.concat([cipher.update(mutation.value, "utf8"), cipher.final()]);
    await this.repository.put({
      coordinates,
      envelopeVersion: ENVELOPE_VERSION,
      nonce,
      authTag: cipher.getAuthTag(),
      ciphertext,
      updatedAt: new Date().toISOString(),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.key.fill(0);
    await this.repository.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("secret resolver is closed");
  }
}

export interface CreatePostgresSecretResolverOptions {
  connectionString: string;
  masterKey: Uint8Array;
  pool?: Pool;
  poolMax?: number;
  runMigrations?: boolean;
}

export async function createPostgresSecretResolver(
  options: CreatePostgresSecretResolverOptions,
): Promise<Aes256GcmSecretResolver> {
  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? new Pool({ connectionString: options.connectionString, max: options.poolMax ?? 10 });
  try {
    if (options.runMigrations !== false) await runPostgresSecretMigrations(pool);
    return new Aes256GcmSecretResolver(
      // Pool ownership follows the factory; injected pools remain reusable.
      new PostgresSecretEnvelopeRepository(pool, ownsPool),
      options.masterKey,
    );
  } catch (error) {
    if (ownsPool) await pool.end().catch(() => undefined);
    throw error;
  }
}

const coordinateParams = (coordinates: SecretCoordinates): [TenantId, string, string, string] => [
  coordinates.tenantId,
  coordinates.purpose,
  coordinates.resourceId,
  coordinates.field,
];

function aadFor(coordinates: SecretCoordinates, version: number): Buffer {
  return Buffer.from(JSON.stringify({
    field: coordinates.field,
    purpose: coordinates.purpose,
    resource_id: coordinates.resourceId,
    tenant_id: coordinates.tenantId,
    version,
  }), "utf8");
}

function sameCoordinates(left: SecretCoordinates, right: SecretCoordinates): boolean {
  return left.tenantId === right.tenantId
    && left.purpose === right.purpose
    && left.resourceId === right.resourceId
    && left.field === right.field;
}

interface SecretEnvelopeRow extends QueryResultRow {
  tenant_id: string;
  purpose: string;
  resource_id: string;
  field: string;
  envelope_version: number | string;
  nonce: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
  updated_at: Date | string;
}
