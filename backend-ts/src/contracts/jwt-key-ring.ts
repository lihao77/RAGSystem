export interface JwtSigningKey {
  kid: string;
  secret: Uint8Array;
  /** Unix epoch seconds after which the key must no longer verify tokens. */
  expiresAt?: number;
}

export interface JwtKeyRingReadiness {
  ready: boolean;
  activeKid: string | null;
  verificationKids: string[];
  reason?: "missing_active_key" | "active_key_expired";
}

export interface JwtKeyRing {
  getActiveSigningKey(nowSeconds?: number): JwtSigningKey;
  getVerificationKey(kid: string | undefined, nowSeconds?: number): JwtSigningKey | null;
  readiness(nowSeconds?: number): JwtKeyRingReadiness;
}
