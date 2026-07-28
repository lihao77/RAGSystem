import { createSaaSDeploymentRuntime } from "./adapters/saas/composition/saas-deployment-runtime.js";
import { loadEnv } from "@ragsystem/backend-core/config/env.js";
import { buildCoreApp } from "@ragsystem/backend-core/core-app.js";
import { createSaaSProductPlugins } from "./product-plugins.js";

const env = loadEnv(process.env);
const deployment = await createSaaSDeploymentRuntime(env);
let app;

try {
  app = await buildCoreApp({ env, runtime: deployment, plugins: createSaaSProductPlugins(deployment) });
  const address = await app.listen({ host: env.host, port: env.port });
  app.log.info({ address, deployment: "saas", storage: "postgres", objectStorage: "s3" }, "backend-saas listening");
} catch (error) {
  await app?.close().catch(() => undefined);
  await deployment.close().catch(() => undefined);
  throw error;
}

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, "backend-saas shutting down");
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ error }, "backend-saas shutdown failed");
    process.exit(1);
  }
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
