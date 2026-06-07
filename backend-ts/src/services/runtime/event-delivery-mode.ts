export type TerminalEventDeliveryMode = "sync" | "outbox_live";

export const DEFAULT_TERMINAL_EVENT_DELIVERY_MODE: TerminalEventDeliveryMode = "outbox_live";

export function parseTerminalEventDeliveryMode(value: string | undefined | null): TerminalEventDeliveryMode {
  const normalized = value?.trim();
  if (!normalized) {
    return DEFAULT_TERMINAL_EVENT_DELIVERY_MODE;
  }
  if (normalized === "sync" || normalized === "outbox_live") {
    return normalized;
  }
  throw new Error(`Invalid BACKEND_TS_TERMINAL_EVENT_DELIVERY: ${value}`);
}
