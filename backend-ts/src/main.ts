import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createSaaSMemoryRuntime, type SaaSMemoryRuntimeHandle } from "./services/runtime/saas-memory-runtime.js";

const env = loadEnv(process.env);
let saasMemoryRuntime: SaaSMemoryRuntimeHandle | undefined;
let app;
try {
  if (env.storageMode === "postgres") {
    if (!env.databaseUrl) throw new Error("STORAGE_MODE=postgres requires DATABASE_URL (or POSTGRES_URL)");
    saasMemoryRuntime = await createSaaSMemoryRuntime({
      connectionString: env.databaseUrl,
      poolMax: env.postgresPoolMax,
    });
  }
  app = await buildApp({
    env,
    ...(saasMemoryRuntime ? { saasMemoryRuntime } : {}),
  });
} catch (error) {
  await saasMemoryRuntime?.close().catch(() => undefined);
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
