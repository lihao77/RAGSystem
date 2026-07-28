import type { JwtKeyRing } from "@ragsystem/backend-core/contracts/runtime/jwt-key-ring.js";
import { createJwtKeyRing } from "@ragsystem/backend-core/services/runtime/jwt-key-ring.js";

export function parseWidgetJwtKeyRing(rawValue: string | undefined): JwtKeyRing | undefined {
  if (!rawValue?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error("WIDGET_JWT_KEY_RING must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("WIDGET_JWT_KEY_RING must be an object");
  const value = parsed as { active?: unknown; previous?: unknown };
  if (value.active === undefined || !Array.isArray(value.previous ?? [])) {
    throw new Error("WIDGET_JWT_KEY_RING requires active and previous[]");
  }
  const ring = createJwtKeyRing({
    active: value.active as { kid: string; secret: string; expiresAt?: number },
    previous: value.previous as Array<{ kid: string; secret: string; expiresAt?: number }>,
  });
  const readiness = ring.readiness();
  if (!readiness.ready) throw new Error(`WIDGET_JWT_KEY_RING is not ready: ${readiness.reason ?? "unknown"}`);
  return ring;
}
