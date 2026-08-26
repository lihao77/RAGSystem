import { z } from "zod";

import type { SystemConfigExtension } from "@ragsystem/backend-core/contracts/runtime/system-config.js";

const PetConfigSchema = z.object({
  default_animation: z.string().default("idle"),
  scale: z.number().min(0.5).max(2).default(1),
  notice_enabled: z.boolean().default(true),
}).strict();

export type PetConfig = z.infer<typeof PetConfigSchema>;

export const DEFAULT_PET_CONFIG: PetConfig = PetConfigSchema.parse({});

/** 解析 systemConfig 的 pet 节；非法/缺失字段回退默认值（独立窗等无租户上下文场景也用它兜底）。 */
export function resolvePetConfig(value: unknown): PetConfig {
  const parsed = PetConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_PET_CONFIG;
}

/**
 * pet 组（租户级/场景级）：组 key "pet" 对应配置根节 pet；
 * 注册时把已持久化的当前值回灌 defaults，避免 rebuildProjection 丢已存值（skills 同款模式）。
 */
export function createPetSystemConfigExtension(currentValue: unknown): SystemConfigExtension {
  return {
    defaults: { pet: resolvePetConfig(currentValue) },
    groups: [
      {
        key: "pet",
        label: "宠物",
        description: "桌宠插件配置（本场景生效；独立宠物窗无登录态时使用默认值）",
        fields: [
          {
            key: "default_animation",
            label: "默认动画",
            type: "text",
            default: "idle",
            help: "初始展示的动画名（见 /api/pet/manifest 清单）",
          },
          {
            key: "scale",
            label: "显示缩放",
            type: "number",
            default: 1,
            min: 0.5,
            max: 2,
            step: 0.1,
            help: "宠物渲染尺寸缩放倍数",
          },
          {
            key: "notice_enabled",
            label: "任务通知",
            type: "boolean",
            default: true,
            help: "任务完成/失败/需要确认时，窗口失焦则弹系统桌面通知（宠物本体不参与）",
          },
        ],
      },
    ],
  };
}
