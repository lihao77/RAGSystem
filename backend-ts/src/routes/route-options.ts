import type { IdentityProvider } from "../services/identity/index.js";
import type { WidgetAuthService } from "../services/runtime/jwt-service.js";
import type { TenantRuntimeRegistry } from "../services/runtime/tenant-runtime-registry.js";
import type { WidgetCredentialStore } from "../services/stores/widget-credential-store/index.js";

export interface RouteOptions {
  registry: TenantRuntimeRegistry;
  identityProvider: IdentityProvider;
  widgetCredentialStore?: WidgetCredentialStore;
  widgetAuth?: WidgetAuthService;
}
