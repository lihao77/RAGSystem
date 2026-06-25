/**
 * PermissionPolicy 端口适配器 —— 把 backend-ts PermissionPolicyService 适配成 SDK 的 PermissionPolicy 端口。
 *
 * SDK 内置审批编排（tool-round-executor），消费端只需注入策略判定。本适配器把 SDK 的
 * ToolApprovalInput 映射成 backend-ts evaluateToolApproval 入参，再把 RuntimeToolApprovalDecision
 * 映射回 SDK ToolApprovalDecision（allow/ask/deny + approvedExternalPaths）。
 *
 * backend-ts evaluateToolApproval 只产 allow/ask（dangerous/越界等 deny 由 SDK 编排在
 * prepare 阶段或交互拒绝处理）；ask 时透传 approvedExternalPaths 供 SDK 回填执行 ctx。
 */
import type { PermissionPolicy, ToolApprovalDecision, ToolApprovalInput } from "@ragsystem/agent-sdk";
import type { RiskLevel } from "../../../contracts/permissions.js";
import type { PermissionPolicyService, RuntimeToolApprovalInput } from "../../runtime/permission-policy-service.js";

export interface SdkPermissionPolicyAdapterOptions {
  /** backend-ts 权限策略服务（持有 mode / auto_accept / session override 等规则）。 */
  service: PermissionPolicyService;
}

export class SdkPermissionPolicyAdapter implements PermissionPolicy {
  constructor(private readonly options: SdkPermissionPolicyAdapterOptions) {}

  evaluate(input: ToolApprovalInput): ToolApprovalDecision {
    const serviceInput: RuntimeToolApprovalInput = {
      toolName: input.toolName,
      riskLevel: normalizeRiskLevel(input.riskLevel),
      arguments: input.arguments,
      sessionId: input.ctx.sessionId ?? undefined,
      approvalExempt: input.approvalExempt,
      ...(input.forceAsk ? { forceAsk: true } : {}),
      ...(input.approvedExternalPaths?.length ? { approvedExternalPaths: input.approvedExternalPaths } : {}),
    };
    const decision = this.options.service.evaluateToolApproval(serviceInput);
    if (decision.action === "allow") {
      return {
        action: "allow",
        reason: decision.reason,
        ...(decision.approvedExternalPaths.length ? { approvedExternalPaths: decision.approvedExternalPaths } : {}),
      };
    }
    return {
      action: "ask",
      reason: decision.reason,
      riskLevel: decision.riskLevel,
      description: decision.description,
      ...(decision.approvedExternalPaths.length ? { approvedExternalPaths: decision.approvedExternalPaths } : {}),
    };
  }
}

function normalizeRiskLevel(value: string): RiskLevel | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}
