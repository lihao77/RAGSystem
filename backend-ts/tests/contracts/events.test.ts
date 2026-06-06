import { describe, expect, it } from "vitest";

import { ClientEventTypeSchema, ClientToServerMessageSchema } from "../../src/contracts/events.js";

describe("client event contract", () => {
  it("includes interaction and legacy user input acknowledgement events", () => {
    expect(ClientEventTypeSchema.safeParse("interaction.required").success).toBe(true);
    expect(ClientEventTypeSchema.safeParse("interaction.ack").success).toBe(true);
    expect(ClientEventTypeSchema.safeParse("interaction.error").success).toBe(true);
    expect(ClientEventTypeSchema.safeParse("user.approval_granted").success).toBe(true);
    expect(ClientEventTypeSchema.safeParse("user.approval_denied").success).toBe(true);
    expect(ClientEventTypeSchema.safeParse("user_input.ack").success).toBe(true);
    expect(ClientEventTypeSchema.safeParse("user_input.error").success).toBe(true);
  });

  it("accepts generic interaction response client messages", () => {
    expect(
      ClientToServerMessageSchema.parse({
        type: "interaction.respond",
        interaction_id: "input-1",
        kind: "user_input",
        value: "session",
      }),
    ).toMatchObject({
      type: "interaction.respond",
      interaction_id: "input-1",
      kind: "user_input",
      value: "session",
    });
  });
});
