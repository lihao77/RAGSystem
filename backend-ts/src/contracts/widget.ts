import { z } from "zod";

const WidgetOriginSchema = z.string().regex(/^https?:\/\/[^/]+(?::\d+)?$/, "origin must be protocol://host[:port]");
export const WidgetAppViewSchema = z.object({ app_key: z.string().startsWith("wid_pk_"), secret_prefix: z.string(), display_name: z.string(), allowed_origins: z.array(WidgetOriginSchema), created_at: z.string(), revoked_at: z.string().nullable() });
export type WidgetAppView = z.infer<typeof WidgetAppViewSchema>;
export const CreatedWidgetAppViewSchema = WidgetAppViewSchema.omit({ created_at: true, revoked_at: true }).extend({ secret: z.string().startsWith("wid_sk_") });
export type CreatedWidgetAppView = z.infer<typeof CreatedWidgetAppViewSchema>;
export const CreateWidgetAppRequestSchema = z.object({ display_name: z.string().trim().min(1).max(120), allowed_origins: z.array(WidgetOriginSchema).default([]) });
export type CreateWidgetAppRequest = z.infer<typeof CreateWidgetAppRequestSchema>;
export const UpdateWidgetAppRequestSchema = z.object({ display_name: z.string().trim().min(1).max(120).optional(), allowed_origins: z.array(WidgetOriginSchema).optional() }).refine((value) => value.display_name !== undefined || value.allowed_origins !== undefined, "at least one field is required");
export type UpdateWidgetAppRequest = z.infer<typeof UpdateWidgetAppRequestSchema>;
export const WidgetTokenViewSchema = z.object({ jti: z.string(), app_key: z.string(), issued_at: z.number().int(), expires_at: z.number().int(), revoked: z.boolean() });
export type WidgetTokenView = z.infer<typeof WidgetTokenViewSchema>;
export const WidgetAuditViewSchema = z.object({ id: z.number().int(), app_key: z.string(), action: z.string(), actor: z.string(), detail: z.record(z.string(), z.unknown()).nullable(), created_at: z.string() });
export type WidgetAuditView = z.infer<typeof WidgetAuditViewSchema>;

/**
 * widget 第三方嵌入接入契约。
 *
 * 鉴权模型：嵌入方服务端持 app-key/secret → POST /api/widget/auth/token 换短时 JWT →
 * 带 Bearer JWT 调 POST /api/widget/sessions 签发受约束会话 → 用该会话连 WS。
 * 与既有 /api/agent/* 端点解耦，互不影响。
 */

/** 换 token 请求：app_key（公钥身份）+ secret（私钥，后端仅存 hash）。 */
export const WidgetTokenRequestSchema = z.object({
  app_key: z.string().min(1),
  secret: z.string().min(1),
});
export type WidgetTokenRequest = z.infer<typeof WidgetTokenRequestSchema>;

/** 签发 widget 会话请求：可选业务 metadata + 声明允许的宿主工具白名单。 */
export const WidgetCreateSessionRequestSchema = z.object({
  metadata: z.record(z.string(), z.unknown()).optional(),
  host_tools: z.array(z.string()).optional(),
});
export type WidgetCreateSessionRequest = z.infer<typeof WidgetCreateSessionRequestSchema>;
