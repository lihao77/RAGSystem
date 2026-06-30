import { z } from "zod";

export const InteractionKindSchema = z.enum(["user_input", "approval"]);

export const InteractionResponsePayloadSchema = z.object({
  kind: InteractionKindSchema.optional(),
  value: z.string().optional().default(""),
  approved: z.boolean().optional(),
  message: z.string().optional().default(""),
});

export type InteractionKind = z.infer<typeof InteractionKindSchema>;
export type InteractionResponsePayload = z.input<typeof InteractionResponsePayloadSchema>;
