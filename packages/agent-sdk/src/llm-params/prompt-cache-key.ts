import { createHash } from "node:crypto";
import type { RuntimeSession } from "../contracts.js";

/** Stable per agent thread, while hiding raw session and tenant identifiers from provider logs. */
export function buildPromptCacheKey(session: RuntimeSession): string {
  const provider = session.provider;
  const material = [
    provider?.key ?? provider?.name ?? provider?.provider_type ?? "",
    provider?.provider_type ?? "",
    session.modelName ?? "",
    session.sessionId,
    session.threadKey,
    session.profile.agentName,
  ].join("\u0000");
  const digest = createHash("sha256").update(material).digest("base64url").slice(0, 32);
  return `ragsystem:${digest}`;
}
