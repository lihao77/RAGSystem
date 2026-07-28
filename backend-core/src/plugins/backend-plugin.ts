import type { FastifyInstance } from "fastify";

import type { CapabilityRegistry } from "./capability-registry.js";

export type BackendRouteScope = "public" | "tenant" | "management" | "platform" | "widget";

export type BackendRouteInstaller = (app: FastifyInstance) => Promise<void>;

export interface BackendRouteContribution {
  readonly pluginId: string;
  readonly scope: BackendRouteScope;
  readonly prefix: string;
  readonly install: BackendRouteInstaller;
}

export interface PluginRouteRegistrar {
  register(scope: BackendRouteScope, prefix: string, install: BackendRouteInstaller): void;
}

export interface BackendPluginContext {
  readonly capabilities: CapabilityRegistry;
  readonly routes: PluginRouteRegistrar;
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
