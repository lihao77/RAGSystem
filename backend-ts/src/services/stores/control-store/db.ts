import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { runControlMigrations } from "./migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export type ControlDb = import("node:sqlite").DatabaseSync;

export function createControlDb(systemRoot: string): ControlDb {
  const resolvedSystemRoot = path.resolve(systemRoot);
  fs.mkdirSync(resolvedSystemRoot, { recursive: true });
  const db = new DatabaseSync(path.join(resolvedSystemRoot, "control.db"));
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  runControlMigrations(db);
  return db;
}
