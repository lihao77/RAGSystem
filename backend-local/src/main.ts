import { createLocalDeploymentRuntime } from "./adapters/local/composition/local-deployment-runtime.js";
import { loadEnv, loadEnvSource } from "@ragsystem/backend-core/config/env.js";
import { buildCoreApp } from "@ragsystem/backend-core/core-app.js";
import { createLocalProductPlugins } from "./product-plugins.js";

const environment = loadEnvSource(process.env, process.env.INIT_CWD?.trim() || process.cwd());
// Plugin modules are loaded dynamically and may read process.env during create().
// Keep the resolved .env source visible to those modules while preserving
// values explicitly supplied by the parent process (loadEnvSource precedence).
Object.assign(process.env, environment);
const env = loadEnv(environment);
const socketPath = environment.BACKEND_TS_SOCKET_PATH?.trim();
const deployment = createLocalDeploymentRuntime(env);
let app;

try {
  app = await buildCoreApp({
    env,
    runtime: deployment,
    plugins: await createLocalProductPlugins({
      ...(environment.BACKEND_PLUGIN_CONFIG?.trim()
        ? { configPath: environment.BACKEND_PLUGIN_CONFIG }
        : {}),
      env: environment,
    }),
  });
  const address = socketPath
    ? await app.listen({ path: socketPath })
    : await app.listen({ host: env.host, port: env.port });
  app.log.info(
    { address, socketPath: socketPath || undefined, deployment: "local", storage: "sqlite" },
    "backend-local listening",
  );
} catch (error) {
  await app?.close().catch(() => undefined);
  await deployment.close().catch(() => undefined);
  throw error;
}

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "backend-local shutting down");
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ error }, "backend-local shutdown failed");
    process.exit(1);
  }
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
