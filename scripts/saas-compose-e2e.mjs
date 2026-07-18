import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";

const options = parseArgs(process.argv.slice(2));
const projectName = options.projectName ?? `ragsystem-saas-e2e-${process.pid}-${Date.now()}`;
const ports = {
  backend: options.backendPort ?? await findFreePort(),
  postgres: await findFreePort(),
  minio: await findFreePort(),
  minioConsole: await findFreePort(),
};
const baseUrl = `http://127.0.0.1:${ports.backend}`;
const composeArgs = ["compose", "-p", projectName, "-f", "docker-compose.saas.yml"];
const adminUsername = "saas-e2e-admin";
const adminPassword = `E2e-${randomBytes(18).toString("base64url")}`;
const sessionSecret = randomBytes(48).toString("base64url");
const masterKey = randomBytes(32).toString("base64");
const composeEnv = {
  ...process.env,
  SAAS_BACKEND_PORT: String(ports.backend),
  POSTGRES_PORT: String(ports.postgres),
  MINIO_PORT: String(ports.minio),
  MINIO_CONSOLE_PORT: String(ports.minioConsole),
  SESSION_JWT_SECRET: sessionSecret,
  CONTROL_SECRET_MASTER_KEY: masterKey,
};
let shouldCleanUp = !options.keep;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shouldCleanUp = true;
    process.exitCode = 130;
  });
}

try {
  console.log(`[saas-e2e] project=${projectName} backend=${baseUrl}`);
  await compose(["up", "-d", ...(options.build ? ["--build"] : []), "backend"]);
  await waitForReady(baseUrl, options.timeoutMs);
  await verifyHealth(baseUrl);

  await requestJson(baseUrl, "/api/install", {
    method: "POST",
    body: {
      deployment: "saas",
      tenancy: "multi",
      admin: { username: adminUsername, password: adminPassword },
      tenantDisplayName: "SaaS E2E Default",
    },
  });
  const initialLogin = await login(baseUrl, adminUsername, adminPassword);
  const defaultToken = await tokenForTenant(baseUrl, initialLogin, "tnt_default");

  const defaultSessionId = `e2e-default-${randomUUID()}`;
  await createSession(baseUrl, defaultToken, defaultSessionId);

  const tenantResult = await requestJson(baseUrl, "/api/admin/tenants", {
    method: "POST",
    token: defaultToken,
    body: { displayName: "SaaS E2E Isolated" },
  });
  const secondTenantId = requireString(tenantResult?.tenant?.id, "created tenant id");
  const switched = await requestJson(baseUrl, "/api/auth/switch-tenant", {
    method: "POST",
    token: defaultToken,
    body: { tenantId: secondTenantId },
  });
  const secondToken = requireString(switched?.token, "second tenant token");
  const secondSessionId = `e2e-isolated-${randomUUID()}`;
  await createSession(baseUrl, secondToken, secondSessionId);

  await expectStatus(baseUrl, `/api/agent/sessions/${secondSessionId}`, 404, defaultToken);
  await expectStatus(baseUrl, `/api/agent/sessions/${defaultSessionId}`, 404, secondToken);
  console.log("[saas-e2e] tenant isolation passed");

  const defaultMemoryMarker = `memory-default-${randomUUID()}`;
  const secondMemoryMarker = `memory-isolated-${randomUUID()}`;
  await seedMemoryEntry("tnt_default", initialLogin.userId, defaultMemoryMarker);
  await seedMemoryEntry(secondTenantId, initialLogin.userId, secondMemoryMarker);
  await expectMemoryVisible(baseUrl, defaultToken, defaultMemoryMarker);
  await expectMemoryVisible(baseUrl, secondToken, secondMemoryMarker);
  await expectMemoryHidden(baseUrl, defaultToken, secondMemoryMarker);
  await expectMemoryHidden(baseUrl, secondToken, defaultMemoryMarker);
  console.log("[saas-e2e] PostgreSQL memory read and tenant isolation passed");

  const attachmentBody = `SaaS ObjectStorage persistence ${randomUUID()}\n`;
  const attachment = await uploadSessionFile(baseUrl, defaultToken, defaultSessionId, attachmentBody);
  await expectDownloadedFile(baseUrl, defaultToken, defaultSessionId, attachment.id, attachmentBody);
  await expectStatus(baseUrl, `/api/agent/sessions/${defaultSessionId}/files/${attachment.id}/download`, 404, secondToken);
  console.log("[saas-e2e] ObjectStorage attachment upload, download and tenant isolation passed");

  await compose(["restart", "backend"]);
  await waitForReady(baseUrl, options.timeoutMs);
  const afterRestartLogin = await login(baseUrl, adminUsername, adminPassword);
  const afterRestartDefaultToken = await tokenForTenant(baseUrl, afterRestartLogin, "tnt_default");
  const afterRestartSecondToken = await tokenForTenant(baseUrl, afterRestartLogin, secondTenantId);
  await expectStatus(baseUrl, `/api/agent/sessions/${defaultSessionId}`, 200, afterRestartDefaultToken);
  await expectStatus(baseUrl, `/api/agent/sessions/${secondSessionId}`, 200, afterRestartSecondToken);
  await expectMemoryVisible(baseUrl, afterRestartDefaultToken, defaultMemoryMarker);
  await expectMemoryVisible(baseUrl, afterRestartSecondToken, secondMemoryMarker);
  await expectDownloadedFile(baseUrl, afterRestartDefaultToken, defaultSessionId, attachment.id, attachmentBody);
  await expectStatus(baseUrl, `/api/agent/sessions/${defaultSessionId}/files/${attachment.id}/download`, 404, afterRestartSecondToken);
  console.log("[saas-e2e] restart persistence passed");
  console.log("[saas-e2e] PASS");
} catch (error) {
  console.error(`[saas-e2e] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  await compose(["logs", "--no-color", "--tail", "200", "backend", "postgres", "minio"], false);
  process.exitCode = 1;
} finally {
  if (shouldCleanUp) {
    await compose(["down", "--volumes", "--remove-orphans"], false);
  } else {
    console.log(`[saas-e2e] retained project: docker compose -p ${projectName} -f docker-compose.saas.yml ps`);
  }
}

async function compose(args, rejectOnFailure = true) {
  const exitCode = await run("docker", [...composeArgs, ...args], composeEnv);
  if (rejectOnFailure && exitCode !== 0) {
    throw new Error(`docker ${[...composeArgs, ...args].join(" ")} exited with ${exitCode}`);
  }
  return exitCode;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function verifyHealth(url) {
  const live = await requestJson(url, "/livez");
  assert(live?.status === "alive", "livez did not report alive");
  const ready = await requestJson(url, "/readyz");
  assert(ready?.status === "ready", "readyz did not report ready");
  assert(ready?.checks?.control_database === "ok", "control database readiness failed");
  console.log("[saas-e2e] health passed");
}

async function waitForReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/readyz`);
      if (response.ok && (await response.json())?.status === "ready") return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`backend readiness timed out after ${timeoutMs}ms (${lastError})`);
}

async function login(url, username, password) {
  const result = await requestJson(url, "/api/auth/login", {
    method: "POST",
    body: { username, password },
  });
  return {
    token: requireString(result?.token, "login token"),
    tenantId: requireString(result?.tenantId, "login tenant id"),
    userId: requireString(result?.user?.id, "login user id"),
  };
}

async function tokenForTenant(url, loginResult, tenantId) {
  if (loginResult.tenantId === tenantId) return loginResult.token;
  const switched = await requestJson(url, "/api/auth/switch-tenant", {
    method: "POST",
    token: loginResult.token,
    body: { tenantId },
  });
  return requireString(switched?.token, `token for tenant ${tenantId}`);
}

async function createSession(url, token, sessionId) {
  await requestJson(url, "/api/agent/sessions", {
    method: "POST",
    token,
    body: { session_id: sessionId },
  });
}

async function seedMemoryEntry(tenantId, userId, marker) {
  const id = randomUUID();
  const values = [id, tenantId, userId, marker].map(sqlLiteral);
  const sql = `INSERT INTO memory_entries(id,tenant_id,scope,scope_id,name,description,memory_type,content) VALUES(${values[0]},${values[1]},'user',${values[2]},${values[3]},'SaaS Compose E2E fixture','fact',${values[3]})`;
  await compose(["exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "ragsystem", "-d", "ragsystem", "-c", sql]);
}

async function expectMemoryVisible(url, token, marker) {
  const result = await requestJson(url, `/api/memory/entries?scope=user&status=active&search=${encodeURIComponent(marker)}`, { token });
  const items = Array.isArray(result?.data?.items) ? result.data.items : [];
  assert(items.some((item) => item?.name === marker && item?.content === marker), `memory ${marker} was not visible`);
}

async function expectMemoryHidden(url, token, marker) {
  const result = await requestJson(url, `/api/memory/entries?scope=user&status=active&search=${encodeURIComponent(marker)}`, { token });
  const items = Array.isArray(result?.data?.items) ? result.data.items : [];
  assert(items.length === 0, `memory ${marker} leaked across tenants`);
}

async function uploadSessionFile(url, token, sessionId, body) {
  const form = new FormData();
  form.append("files", new Blob([body], { type: "text/plain" }), "saas-e2e.txt");
  const response = await fetch(`${url}/api/agent/sessions/${sessionId}/files/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`attachment upload failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  const result = JSON.parse(text);
  const file = Array.isArray(result?.files) ? result.files[0] : null;
  return { id: requireString(file?.id, "uploaded attachment id") };
}

async function expectDownloadedFile(url, token, sessionId, fileId, expectedBody) {
  const response = await fetch(`${url}/api/agent/sessions/${sessionId}/files/${fileId}/download`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`attachment download failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  assert(body === expectedBody, `attachment content mismatch: expected ${expectedBody.length} bytes, received ${body.length}`);
}

async function expectStatus(url, path, expected, token) {
  const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status !== expected) {
    throw new Error(`${path} expected HTTP ${expected}, received ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
}

async function requestJson(url, path, options = {}) {
  const response = await fetch(`${url}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* error below retains response text */ }
  if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  return body;
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function requireString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArgs(args) {
  const parsed = { build: true, keep: false, timeoutMs: 180_000, projectName: null, backendPort: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--no-build") parsed.build = false;
    else if (arg === "--keep") parsed.keep = true;
    else if (arg === "--project-name") parsed.projectName = requireArg(args, ++index, arg);
    else if (arg === "--backend-port") parsed.backendPort = positiveInt(requireArg(args, ++index, arg), arg);
    else if (arg === "--timeout-ms") parsed.timeoutMs = positiveInt(requireArg(args, ++index, arg), arg);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm run e2e:saas-compose -- [--no-build] [--keep] [--project-name name] [--backend-port port] [--timeout-ms ms]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requireArg(args, index, flag) {
  if (!args[index]) throw new Error(`${flag} requires a value`);
  return args[index];
}

function positiveInt(value, flag) {
  const number = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${flag} must be a positive integer`);
  return number;
}
