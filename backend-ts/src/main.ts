import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv(process.env);
const app = await buildApp({ env });

const address = await app.listen({ host: env.host, port: env.port });
app.log.info({ address }, "backend-ts listening");

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
