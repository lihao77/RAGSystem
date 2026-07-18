import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

import {
  PgPoolMemoryExecutor,
  PostgresMemoryImporter,
  runPostgresMemoryMigrations,
  type MemoryImportConflictPolicy,
  type PostgresMemoryImportResult,
} from "../src/adapters/saas/postgres/index.js";
import { scanFilesystemMemory } from "../src/services/memory-import/filesystem-memory-scanner.js";

interface Options {
  sourceDataRoot: string;
  tenantId: string;
  databaseUrl: string | null;
  dryRun: boolean;
  conflict: MemoryImportConflictPolicy;
  reportPath: string | null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const scan = scanFilesystemMemory(options.sourceDataRoot, options.tenantId);
  const report: {
    dry_run: boolean;
    source_data_root: string;
    memory_root_found: boolean;
    tenant_id: string;
    semantic_checksum: string;
    scanned_entries: number;
    issues: typeof scan.issues;
    excluded: typeof scan.excluded;
    import: PostgresMemoryImportResult | null;
  } = {
    dry_run: options.dryRun,
    source_data_root: scan.source_data_root,
    memory_root_found: scan.memory_root_found,
    tenant_id: scan.tenant_id,
    semantic_checksum: scan.semantic_checksum,
    scanned_entries: scan.entries.length,
    issues: scan.issues,
    excluded: scan.excluded,
    import: null,
  };

  if (!scan.memory_root_found) {
    await emitReport(report, options.reportPath);
    throw new Error(`No Local Memory root found under ${scan.source_data_root}`);
  }
  if (scan.issues.length > 0) {
    await emitReport(report, options.reportPath);
    throw new Error(`Memory scan found ${scan.issues.length} invalid file(s); no data was written`);
  }
  if (scan.excluded.legacy_workspaces > 0) {
    await emitReport(report, options.reportPath);
    throw new Error("Legacy workspace Memory requires an explicit user mapping before import");
  }
  if (!options.dryRun) {
    if (!options.databaseUrl) throw new Error("--database-url or DATABASE_URL/POSTGRES_URL is required");
    const pool = new Pool({ connectionString: options.databaseUrl });
    try {
      const executor = new PgPoolMemoryExecutor(pool);
      await runPostgresMemoryMigrations(executor);
      report.import = await new PostgresMemoryImporter(executor).importEntries(
        scan.tenant_id,
        scan.entries,
        options.conflict,
      );
    } finally {
      await pool.end();
    }
  }
  await emitReport(report, options.reportPath);
}

function parseArgs(args: string[]): Options {
  let sourceDataRoot: string | null = null;
  let tenantId: string | null = null;
  let databaseUrl = process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim() || null;
  let dryRun = false;
  let conflict: MemoryImportConflictPolicy = "error";
  let reportPath: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--source-data-root" || arg === "--data-root") {
      sourceDataRoot = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--tenant-id") {
      tenantId = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--database-url") {
      databaseUrl = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--conflict") {
      const value = requireValue(args, ++index, arg);
      if (value !== "error" && value !== "skip") throw new Error("--conflict must be error or skip");
      conflict = value;
      continue;
    }
    if (arg === "--report") {
      reportPath = path.resolve(requireValue(args, ++index, arg));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!sourceDataRoot) throw new Error("--source-data-root is required");
  if (!tenantId) throw new Error("--tenant-id is required");
  return {
    sourceDataRoot: path.resolve(sourceDataRoot),
    tenantId,
    databaseUrl,
    dryRun,
    conflict,
    reportPath,
  };
}

async function emitReport(report: unknown, reportPath: string | null): Promise<void> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  if (!reportPath) return;
  await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.promises.writeFile(reportPath, serialized, "utf8");
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value?.trim()) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(`Usage: npm run migrate:memory-postgres -- --source-data-root <path> --tenant-id <id> [options]

Imports Local filesystem Memory from an explicit dataRoot into PostgreSQL.

Options:
  --source-data-root <path>  Source tenant dataRoot. --data-root is an alias.
  --tenant-id <id>          Target SaaS tenant id.
  --database-url <url>      PostgreSQL URL. Defaults to DATABASE_URL or POSTGRES_URL.
  --dry-run                 Scan and validate without connecting to PostgreSQL.
  --conflict <error|skip>   Different existing data policy. Default: error.
  --report <path>           Also write the JSON report to this path.

MEMORY.md is derived and skipped. SQLite memory candidates are not imported by this command.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
