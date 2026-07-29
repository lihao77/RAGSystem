import { createLocalDeploymentRuntime } from "./adapters/local/composition/local-deployment-runtime.js";
import { loadEnv, loadEnvSource } from "@ragsystem/backend-core/config/env.js";
import { buildCoreApp } from "@ragsystem/backend-core/core-app.js";
import { createLocalProductPlugins } from "./product-plugins.js";

const environment = loadEnvSource(process.env);
const env = loadEnv(environment);
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
  const address = await app.listen({ host: env.host, port: env.port });
  app.log.info({ address, deployment: "local", storage: "sqlite" }, "backend-local listening");
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
