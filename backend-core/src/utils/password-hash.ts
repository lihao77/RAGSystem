import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(plain, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_P}:${SCRYPT_R}:${salt.toString("hex")}:${derived.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [algorithm, rawN, rawP, rawR, saltHex, hashHex, ...rest] = stored.split(":");
  if (algorithm !== "scrypt" || rest.length > 0 || !rawN || !rawP || !rawR || !saltHex || !hashHex) return false;
  const N = Number.parseInt(rawN, 10);
  const p = Number.parseInt(rawP, 10);
  const r = Number.parseInt(rawR, 10);
  if (![N, p, r].every(Number.isSafeInteger) || N <= 1 || p <= 0 || r <= 0) return false;
  try {
    const expected = Buffer.from(hashHex, "hex");
    const salt = Buffer.from(saltHex, "hex");
    if (expected.length === 0 || salt.length === 0) return false;
    const actual = scryptSync(plain, salt, expected.length, { N, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
