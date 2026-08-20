import { createTenantId, createUserId } from "../../identity/types.js";

/**
 * 本地部署的固定身份约定：单一隐式用户（usr_local）+ 默认租户（tnt_local）。
 *
 * 会话可见性等共享策略消费这两个 ID（见 routes/session-owner.ts），因此常量留在 core；
 * 解析行为（含本地多场景）由 backend-local 的身份提供者实现。
 */
export const LOCAL_TENANT_ID = createTenantId("tnt_local");
export const LOCAL_USER_ID = createUserId("usr_local");

/** 控制库 settings 中"当前场景"（活动租户 ID）的键：场景切换端点写入，本地身份提供者读取。 */
export const LOCAL_ACTIVE_TENANT_SETTING = "local_active_tenant";
