import { createUserId, type UserId } from "@ragsystem/backend-core/identity/types.js";

export function widgetUserId(appKey: string): UserId {
  const normalized = appKey.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) {
    throw new Error(`无法从 widget appKey 生成 userId: ${appKey}`);
  }
  return createUserId(`usr_widget_${normalized}`);
}
