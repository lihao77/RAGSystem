/**
 * 前端委托工具声明注册表（per-session）。
 *
 * WS 握手期前端发 tools.register 推送工具清单 → 本表存储 → runtime-adapter per-run 取用，
 * 把前端工具构造为 source=host 转发壳 Tool 合并进 SDK registry。归属判定：工具名在本表即前端委托。
 *
 * 形状对齐 agent-protocol DelegatedToolDeclaration（name/description/input_schema/risk_level/cancellable）。
 */
import type { DelegatedToolDeclarationWire } from "../../contracts/events.js";

export class HostToolRegistry {
  private readonly sessions = new Map<string, Map<string, DelegatedToolDeclarationWire>>();

  /** 覆盖式注册：前端每次推送替换本 session 全量清单。 */
  register(sessionId: string, tools: DelegatedToolDeclarationWire[]): void {
    const map = new Map<string, DelegatedToolDeclarationWire>();
    for (const tool of tools) {
      if (!tool?.name) {
        continue;
      }
      map.set(tool.name, tool);
    }
    this.sessions.set(sessionId, map);
  }

  /** 取本 session 的前端工具清单（无注册返回空数组）。 */
  get(sessionId: string): DelegatedToolDeclarationWire[] {
    const map = this.sessions.get(sessionId);
    return map ? [...map.values()] : [];
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
