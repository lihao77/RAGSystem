import type { TenantId } from "../../identity/types.js";

export interface RuntimeLease<TRuntime> {
  readonly tenantId: TenantId;
  readonly runtime: TRuntime;
  release(): void;
}

export interface RuntimeProvider<TRuntime> {
  acquire(tenantId: string): Promise<RuntimeLease<TRuntime>>;
}

export interface RuntimeRegistry<TRuntime> extends RuntimeProvider<TRuntime> {
  closeTenant(tenantId: string): Promise<void>;
  closeAll(): Promise<void>;
}
