import type { TenantId } from "../../identity/types.js";

export interface SecretCoordinates {
  tenantId: TenantId;
  purpose: string;
  resourceId: string;
  field: string;
}

export type SecretMutation =
  | { kind: "set"; value: string }
  | { kind: "clear" }
  | { kind: "unchanged" };

export interface SecretEnvelopeRecord {
  coordinates: SecretCoordinates;
  envelopeVersion: number;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
  updatedAt: string;
}

export interface SecretEnvelopeRepository {
  get(coordinates: SecretCoordinates): Promise<SecretEnvelopeRecord | null>;
  put(record: SecretEnvelopeRecord): Promise<void>;
  delete(coordinates: SecretCoordinates): Promise<boolean>;
  close(): Promise<void>;
}

export interface SecretResolver {
  resolve(coordinates: SecretCoordinates): Promise<string | null>;
  mutate(coordinates: SecretCoordinates, mutation: SecretMutation): Promise<void>;
  close(): Promise<void>;
}

export class SecretIntegrityError extends Error {
  constructor(message = "secret envelope integrity check failed") {
    super(message);
    this.name = "SecretIntegrityError";
  }
}
