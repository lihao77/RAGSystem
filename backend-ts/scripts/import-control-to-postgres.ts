import { Pool } from "pg";

import { importControlSnapshot } from "../src/adapters/saas/postgres/control-importer.js";

interface CliOptions {
  sourceDataRoot: string;
  databaseUrl: string;
  masterKey: Buffer;
  importId: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: options.databaseUrl });
  try {
    const result = await importControlSnapshot({
      sourceDataRoot: options.sourceDataRoot,
      targetPool: pool,
      masterKey: options.masterKey,
      importId: options.importId,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value?.startsWith("--")) continue;
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`missing value for ${value}`);
    values.set(value.slice(2), next);
    index += 1;
  }
  const sourceDataRoot = values.get("source-data-root") ?? process.env.RAG_DATA_ROOT;
  const databaseUrl = values.get("database-url") ?? process.env.CONTROL_DATABASE_URL ?? process.env.DATABASE_URL;
  const masterKeyValue = values.get("master-key") ?? process.env.CONTROL_SECRET_MASTER_KEY;
  const importId = values.get("import-id");
  if (!sourceDataRoot) throw new Error("--source-data-root or RAG_DATA_ROOT is required");
  if (!databaseUrl) throw new Error("--database-url or CONTROL_DATABASE_URL/DATABASE_URL is required");
  if (!masterKeyValue) throw new Error("--master-key or CONTROL_SECRET_MASTER_KEY is required");
  if (!importId) throw new Error("--import-id is required");
  const masterKey = Buffer.from(masterKeyValue, "base64");
  if (masterKey.length !== 32) throw new Error("master key must be base64 encoded 32 bytes");
  return { sourceDataRoot, databaseUrl, masterKey, importId };
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
