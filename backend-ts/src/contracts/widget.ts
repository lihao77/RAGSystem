import { z } from "zod";

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
