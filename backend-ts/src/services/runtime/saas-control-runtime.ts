import { Pool } from "pg";

import type { BotRepository } from "../../contracts/bot-repository.js";
import type { ControlPlane } from "../../contracts/control-plane/index.js";
import type { SecretResolver } from "../../contracts/secret-resolver.js";
import type { WidgetCredentialRepository } from "../../contracts/widget-credentials.js";
import { PostgresBotRepository } from "../../adapters/saas/postgres/bot-repository.js";
import { createPostgresControlPlaneAdapter } from "../../adapters/saas/postgres/control-plane-adapter.js";
import { createPostgresSecretResolver } from "../../adapters/saas/postgres/control-secret-resolver.js";
import { PostgresWidgetCredentialRepository } from "../../adapters/saas/postgres/widget-credential-repository.js";

export interface SaaSControlRuntimeHandle {
  readonly controlPlane: ControlPlane;
  readonly botRepository: BotRepository;
  readonly widgetCredentials: WidgetCredentialRepository;
  readonly secretResolver: SecretResolver;
  close(): Promise<void>;
}

export interface CreateSaaSControlRuntimeOptions {
  connectionString: string;
  masterKey: Uint8Array;
  poolMax?: number;
}

/** Shared PostgreSQL Control v2 composition. All repositories use one pool. */
export async function createSaaSControlRuntime(
  options: CreateSaaSControlRuntimeOptions,
): Promise<SaaSControlRuntimeHandle> {
  const pool = new Pool({ connectionString: options.connectionString, max: options.poolMax ?? 10 });
  try {
    const controlPlane = await createPostgresControlPlaneAdapter({ pool });
    const secretResolver = await createPostgresSecretResolver({
      connectionString: options.connectionString,
      pool,
      masterKey: options.masterKey,
      runMigrations: false,
    });
    const botRepository = new PostgresBotRepository(pool, secretResolver);
    const widgetCredentials = new PostgresWidgetCredentialRepository(pool);
    let closed = false;
    return {
      controlPlane,
      botRepository,
      widgetCredentials,
      secretResolver,
      async close() {
        if (closed) return;
        closed = true;
        await widgetCredentials.close();
        await secretResolver.close();
        await controlPlane.close();
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
