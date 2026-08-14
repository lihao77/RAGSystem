import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { HookEvent, HookHandler, HookRegistry, Tool } from "@ragsystem/agent-sdk";
import type { MessageAttachment, MessageContentPart } from "@ragsystem/agent-protocol";

import type { AgentConfig } from "../contracts/agent/agent-config.js";
import type { AgentConfigPort } from "../contracts/agent/agent-config.js";
import type { SessionApplication } from "../contracts/session/session-application.js";
import type { PathAccessPolicy } from "../contracts/runtime/path-access-policy.js";
import type { BackgroundTaskPort } from "../contracts/runtime/background-tasks.js";
import type { TenantId } from "../identity/types.js";
import type { ClientEventPublisherPort } from "../contracts/runtime/core-runtime-ports.js";
import type { ModelProviderCatalogPort } from "../contracts/integrations/model-adapter.js";
import type { SystemConfigPort } from "../contracts/runtime/system-config.js";
import type { CapabilityProvider, CapabilityRegistry } from "./capability-registry.js";
import type { RuntimeContainerRegistry } from "../services/runtime/runtime-container-registry.js";
import type { BackendResourceToken, BackendPluginResourceContribution } from "./resource-registry.js";

export type { BackendResourceToken, BackendPluginResourceContribution } from "./resource-registry.js";

export type BackendRouteScope = "public" | "tenant" | "management" | "platform";

export type BackendPluginEventPublisher = (event: string, payload: unknown) => Promise<void>;

export interface BackendRouteInstallContext {
  readonly emitPluginEvent?: BackendPluginEventPublisher;
}

export type BackendRouteInstaller = (
  app: FastifyInstance,
  context: BackendRouteInstallContext,
) => Promise<void>;

export interface BackendRouteContribution {
  readonly pluginId: string;
  readonly scope: BackendRouteScope;
  readonly prefix: string;
  readonly install: BackendRouteInstaller;
}

export interface PluginRouteRegistrar {
  register(scope: BackendRouteScope, prefix: string, install: BackendRouteInstaller): void;
}

/** Registers handlers that are installed into every per-run SDK hook registry. */
export interface PluginHookRegistrar {
  on<E extends HookEvent>(event: E, handler: HookHandler<E>): () => void;
}

export type BackendApplicationEventHandler = (payload: unknown) => void | Promise<void>;

export interface PluginEventRegistrar {
  on(event: string, handler: BackendApplicationEventHandler): () => void;
}

export interface PluginResourceRegistrar {
  register<Value>(token: BackendResourceToken<Value>, value: Value): () => void;
}

export interface BackendToolFactoryContext {
  readonly tenantId: string;
  readonly teamName: string | null;
  readonly agent: AgentConfig;
  readonly pathAccessPolicy: PathAccessPolicy;
  readonly capabilities?: CapabilityRegistry;
  /** 本租户系统配置（工具 factory/call 可读；如视觉辅助模型配置）。 */
  readonly systemConfig?: SystemConfigPort;
  /** 已加载的全部 provider（工具按名称/key 匹配模型用；与投影层同源）。 */
  readonly providers?: readonly import("../contracts/integrations/model-adapter.js").ModelProviderConfig[];
  /**
   * 主模型（default 档，含运行时 selectedLlm 覆盖）是否支持视觉输入；
   * 与上下文投影层的 supportsVision 同源——工具可据此跳过对视觉模型的冗余描述。
   */
  readonly mainModelSupportsVision?: boolean;
  readonly callTool?: (
    toolName: string,
    args: Record<string, unknown>,
    context: import("@ragsystem/agent-sdk").ToolExecContext,
  ) => Promise<import("@ragsystem/agent-sdk").ToolExecutionResult>;
}

export interface BackendToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly risk_level: "low" | "medium" | "high";
}

export type BackendToolFactory = (
  context: BackendToolFactoryContext,
) => Tool | readonly Tool[] | Promise<Tool | readonly Tool[]>;

export interface PluginToolRegistrar {
  register(factory: BackendToolFactory, descriptors?: readonly BackendToolDescriptor[]): () => void;
}

/**
 * 用户消息持久化前变换的输入。
 *
 * 核心在 sendUserMessage 组装 contentParts 后、写入存储前构造该输入并顺序调用
 * 所有已注册 transformer；transformer 返回改写后的 contentParts（或 null 表示不变）。
 */
export interface UserMessageTransformInput {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly contentParts: readonly MessageContentPart[];
  /** 已解析的附件（attachment_resolver 产物，含 file_id/mime/kind）。 */
  readonly attachments: readonly MessageAttachment[];
  /** 按 file_id 读取附件字节；未知或不存在的 file_id 返回 null。 */
  readAttachment(fileId: string): Promise<Uint8Array | null>;
  readonly modelAdapter: ModelProviderCatalogPort;
  /** 本租户系统配置（transformer 每次执行实时读取，保证配置修改即时生效）。 */
  readonly systemConfig: SystemConfigPort;
  readonly signal?: AbortSignal | null;
}

export type UserMessageTransformer = (
  input: UserMessageTransformInput,
) => Promise<MessageContentPart[] | null | undefined> | MessageContentPart[] | null | undefined;

/** Registers transformers applied to every user message right before it is persisted. */
export interface PluginUserMessageTransformerRegistrar {
  register(transformer: UserMessageTransformer): () => void;
}

export interface BackendPluginRuntimeContext {
  readonly deploymentKind: "local" | "saas";
  readonly tenantId: TenantId;
  readonly dataRoot: string;
  readonly modelAdapter: ModelProviderCatalogPort;
  readonly systemConfig: SystemConfigPort;
  readonly agentConfig: AgentConfigPort;
  readonly sessions: SessionApplication;
  readonly backgroundTasks: BackgroundTaskPort;
  readonly clientEvents: ClientEventPublisherPort;
  readonly resources?: readonly BackendPluginResourceContribution[];
  /** Tool descriptors registered by all installed plugins, for runtime control-plane consumers. */
  readonly listPluginTools?: () => readonly BackendToolDescriptor[];
}

export interface BackendPluginRuntimeContribution {
  readonly capabilities?: readonly CapabilityProvider[];
  configureHooks?(registry: HookRegistry): void;
  dispose?(): void;
}

export type BackendPluginRuntimeFactory = (
  context: BackendPluginRuntimeContext,
) => BackendPluginRuntimeContribution | Promise<BackendPluginRuntimeContribution>;

export interface PluginRuntimeRegistrar {
  register(factory: BackendPluginRuntimeFactory): () => void;
}

export interface BackendPluginApplicationContext {
  readonly logger: FastifyBaseLogger;
  readonly registry: RuntimeContainerRegistry;
  readonly resources?: readonly BackendPluginResourceContribution[];
}

export interface BackendPluginApplicationContribution {
  start?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export type BackendPluginApplicationFactory = (
  context: BackendPluginApplicationContext,
) => BackendPluginApplicationContribution | Promise<BackendPluginApplicationContribution>;

export interface PluginApplicationRegistrar {
  register(factory: BackendPluginApplicationFactory): () => void;
}

export interface BackendPluginRuntimeHandle {
  readonly capabilities: CapabilityRegistry;
  configureHooks(registry: HookRegistry): void;
  dispose(): void;
}

/** Immutable deployment input assembled from all registered plugins. */
export interface BackendRuntimeContributions {
  readonly resources: readonly BackendPluginResourceContribution[];
  configureHooks(registry: HookRegistry): void;
  createRuntime(context: BackendPluginRuntimeContext): Promise<BackendPluginRuntimeHandle>;
  createTools(context: BackendToolFactoryContext): Promise<readonly Tool[]>;
  listTools(): readonly BackendToolDescriptor[];
  /** 顺序管道变换用户消息；无 transformer 或全部返回 null 时结果为 null（保持原样）。 */
  transformUserMessage(input: UserMessageTransformInput): Promise<MessageContentPart[] | null>;
}

export interface BackendPluginContext {
  readonly capabilities: CapabilityRegistry;
  readonly hooks: PluginHookRegistrar;
  readonly routes: PluginRouteRegistrar;
  readonly runtimes: PluginRuntimeRegistrar;
  readonly resources: PluginResourceRegistrar;
  readonly tools: PluginToolRegistrar;
  readonly applications: PluginApplicationRegistrar;
  readonly events: PluginEventRegistrar;
  readonly transformers: PluginUserMessageTransformerRegistrar;
}

export interface BackendPluginManifest {
  readonly id: string;
  readonly version: string;
  readonly requires?: readonly string[];
}

export interface BackendPlugin {
  readonly manifest: BackendPluginManifest;
  register(context: BackendPluginContext): void | Promise<void>;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

/** Configuration for one installed plugin module. Disabled entries are never imported. */
export interface InstalledBackendPluginSpec {
  readonly module: string;
  readonly enabled?: boolean;
  readonly config?: unknown;
}

export interface BackendPluginModuleCreateContext {
  readonly config: unknown;
}

/** Stable package entrypoint loaded by the product without a compile-time plugin dependency. */
export interface BackendPluginModule {
  readonly apiVersion: 1;
  readonly manifest: BackendPluginManifest;
  create(context: BackendPluginModuleCreateContext): BackendPlugin | Promise<BackendPlugin>;
}
