import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createSaaSMemoryRuntime, type SaaSMemoryRuntimeHandle } from "./services/runtime/saas-memory-runtime.js";
import { createSaaSControlRuntime, type SaaSControlRuntimeHandle } from "./services/runtime/saas-control-runtime.js";
import { createSaaSConversationRuntime, type SaaSConversationRuntimeHandle } from "./services/runtime/saas-conversation-runtime.js";
import { createSaaSObjectStorage } from "./services/runtime/saas-object-storage.js";
import type { ObjectStorage } from "./contracts/object-storage.js";

const env = loadEnv(process.env);
let saasMemoryRuntime: SaaSMemoryRuntimeHandle | undefined;
let saasControlRuntime: SaaSControlRuntimeHandle | undefined;
let saasConversationRuntime: SaaSConversationRuntimeHandle | undefined;
let saasObjectStorage: ObjectStorage | undefined;
let app;
try {
  if (env.storageMode === "postgres") {
    if (!env.databaseUrl) throw new Error("STORAGE_MODE=postgres requires DATABASE_URL");
    saasMemoryRuntime = await createSaaSMemoryRuntime({
      connectionString: env.databaseUrl,
      poolMax: env.postgresPoolMax,
    });
    saasObjectStorage = createSaaSObjectStorage({ mode: "s3", bucket: env.objectStorageBucket!, endpoint: env.objectStorageEndpoint!, accessKeyId: env.objectStorageAccessKeyId!, secretAccessKey: env.objectStorageSecretAccessKey!, region: env.objectStorageRegion, forcePathStyle: env.objectStorageForcePathStyle });
  }
  if (env.controlStorageMode === "postgres") {
    if (!env.controlDatabaseUrl || !env.controlSecretMasterKey) {
      throw new Error("CONTROL_STORAGE_MODE=postgres requires CONTROL_DATABASE_URL and CONTROL_SECRET_MASTER_KEY");
    }
    saasControlRuntime = await createSaaSControlRuntime({
      connectionString: env.controlDatabaseUrl,
      masterKey: env.controlSecretMasterKey,
      poolMax: env.postgresPoolMax,
    });
  }
  if (env.storageMode === "postgres") {
    if (!env.databaseUrl) throw new Error("STORAGE_MODE=postgres requires DATABASE_URL");
    saasConversationRuntime = await createSaaSConversationRuntime({
      connectionString: env.databaseUrl,
      poolMax: env.postgresPoolMax,
      ...(saasControlRuntime ? { secretResolver: saasControlRuntime.secretResolver } : {}),
      ...(saasObjectStorage ? { objectStorage: saasObjectStorage } : {}),
    });
  }
  app = await buildApp({
    env,
    ...(saasMemoryRuntime ? { saasMemoryRuntime } : {}),
    ...(saasConversationRuntime ? { saasConversationRuntime } : {}),
    ...(saasControlRuntime ? { controlRuntime: saasControlRuntime } : {}),
  });
} catch (error) {
  await saasMemoryRuntime?.close().catch(() => undefined);
  await saasConversationRuntime?.close().catch(() => undefined);
  await saasControlRuntime?.close().catch(() => undefined);
  throw error;
}

let address: string;
try {
  address = await app.listen({ host: env.host, port: env.port });
} catch (error) {
  await app.close().catch(() => undefined);
  throw error;
}
app.log.info({
  address,
  storageMode: env.storageMode ?? "sqlite",
  controlStorageMode: env.controlStorageMode ?? "sqlite",
  memoryStorage: saasMemoryRuntime ? "postgres" : "local",
  runtimeProfile: saasMemoryRuntime ? "hybrid" : "local",
}, "backend-ts listening");

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "backend-ts shutting down");
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ error }, "backend-ts shutdown failed");
    process.exit(1);
  }
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
