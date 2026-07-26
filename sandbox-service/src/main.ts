import { loadConfig } from "./config.js";
import { DockerSandboxEngine } from "./docker-cli.js";
import { SandboxLeaseStore } from "./lease-store.js";
import { createSandboxHttpServer } from "./server.js";

const config = loadConfig(process.env);
const engine = new DockerSandboxEngine(config);
await engine.verify();
await engine.cleanupManagedResources();
const leases = new SandboxLeaseStore(engine, config.maxActiveLeases);
const server = createSandboxHttpServer(config, engine, leases);
await server.listen();
console.log(JSON.stringify({
  event: "sandbox_service_started",
  host: config.host,
  port: config.port,
  runtimeImage: config.runtimeImage,
  dockerRuntime: config.dockerRuntime ?? "default",
}));

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: "sandbox_service_stopping", signal }));
  await server.close().catch(() => undefined);
  await leases.closeAll();
  process.exit(0);
};

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });
