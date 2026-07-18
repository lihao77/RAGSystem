import { describe, expect, it } from "vitest";

import {
  Aes256GcmSecretResolver,
} from "../../src/adapters/saas/postgres/control-secret-resolver.js";
import type {
  SecretCoordinates,
  SecretEnvelopeRecord,
  SecretEnvelopeRepository,
} from "../../src/contracts/secret-resolver.js";
import { SecretIntegrityError } from "../../src/contracts/secret-resolver.js";
import { createTenantId } from "../../src/identity/types.js";

class MemorySecretRepository implements SecretEnvelopeRepository {
  readonly records = new Map<string, SecretEnvelopeRecord>();
  gets = 0;
  puts = 0;
  deletes = 0;

  async get(coordinates: SecretCoordinates) {
    this.gets += 1;
    return this.records.get(key(coordinates)) ?? null;
  }

  async put(record: SecretEnvelopeRecord) {
    this.puts += 1;
    this.records.set(key(record.coordinates), record);
  }

  async delete(coordinates: SecretCoordinates) {
    this.deletes += 1;
    return this.records.delete(key(coordinates));
  }

  async close() {}
}

const tenantA = createTenantId("tnt_secret_a");
const tenantB = createTenantId("tnt_secret_b");
const coordinates = (tenantId = tenantA): SecretCoordinates => ({
  tenantId,
  purpose: "provider",
  resourceId: "provider-1",
  field: "api_key",
});

describe("Aes256GcmSecretResolver", () => {
  it("encrypts, decrypts and does not expose plaintext in the envelope", async () => {
    const repository = new MemorySecretRepository();
    const resolver = new Aes256GcmSecretResolver(repository, Buffer.alloc(32, 7));
    await resolver.mutate(coordinates(), { kind: "set", value: "super-secret" });
    const record = repository.records.get(key(coordinates()))!;
    expect(record.ciphertext.toString("utf8")).not.toContain("super-secret");
    expect(await resolver.resolve(coordinates())).toBe("super-secret");
    await resolver.close();
  });

  it("supports unchanged and clear semantics without accidental writes", async () => {
    const repository = new MemorySecretRepository();
    const resolver = new Aes256GcmSecretResolver(repository, Buffer.alloc(32, 8));
    await resolver.mutate(coordinates(), { kind: "unchanged" });
    expect(repository.gets).toBe(0);
    expect(repository.puts).toBe(0);
    await resolver.mutate(coordinates(), { kind: "set", value: "value" });
    const writes = repository.puts;
    await resolver.mutate(coordinates(), { kind: "unchanged" });
    expect(repository.puts).toBe(writes);
    await resolver.mutate(coordinates(), { kind: "clear" });
    expect(repository.deletes).toBe(1);
    expect(await resolver.resolve(coordinates())).toBeNull();
    await resolver.close();
    await resolver.close();
  });

  it("fails closed on tampering and AAD coordinate changes", async () => {
    const repository = new MemorySecretRepository();
    const resolver = new Aes256GcmSecretResolver(repository, Buffer.alloc(32, 9));
    await resolver.mutate(coordinates(), { kind: "set", value: "value" });
    const record = repository.records.get(key(coordinates()))!;
    record.authTag[0] = (record.authTag[0] ?? 0) ^ 0xff;
    await expect(resolver.resolve(coordinates())).rejects.toBeInstanceOf(SecretIntegrityError);

    await resolver.mutate(coordinates(), { kind: "set", value: "value" });
    const copied = repository.records.get(key(coordinates()))!;
    repository.records.set(key(coordinates(tenantB)), { ...copied, coordinates: coordinates(tenantB) });
    await expect(resolver.resolve(coordinates(tenantB))).rejects.toBeInstanceOf(SecretIntegrityError);
    await resolver.close();
  });

  it("requires an independent 256-bit master key and rejects use after close", async () => {
    const repository = new MemorySecretRepository();
    expect(() => new Aes256GcmSecretResolver(repository, Buffer.alloc(31))).toThrow(/32 bytes/);
    const resolver = new Aes256GcmSecretResolver(repository, Buffer.alloc(32));
    await resolver.close();
    await expect(resolver.resolve(coordinates())).rejects.toThrow("closed");
    await expect(resolver.mutate(coordinates(), { kind: "clear" })).rejects.toThrow("closed");
  });
});

function key(coordinates: SecretCoordinates): string {
  return [coordinates.tenantId, coordinates.purpose, coordinates.resourceId, coordinates.field].join("\u0000");
}
