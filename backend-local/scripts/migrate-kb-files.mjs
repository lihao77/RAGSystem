// 一次性迁移:主库 uploaded_files(scope=global,知识库上传文件)→ knowledge.db kb_files + 移物理 blob。
// 知识库文件体系拆分后,知识库文件归 driver(knowledge.db),uploaded_files 只留会话附件(session scope)。
//
// 用法:
//   DRY_RUN=1 node scripts/migrate-kb-files.mjs [dataRoot]   # 只打印,不写
//   node scripts/migrate-kb-files.mjs [dataRoot]             # 执行迁移
// dataRoot 缺省 ~/.ragsystem。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") ;

const dryRun = process.env.DRY_RUN === "1";
const dataRoot = process.argv[2] ?? path.join(os.homedir(), ".ragsystem");
const mainDbPath = path.join(dataRoot, "db", "ragsystem.db");
const knowledgeDbPath = path.join(dataRoot, "db", "knowledge.db");
const oldUploadsRoot = path.join(dataRoot, "uploads");
const newUploadsRoot = path.join(dataRoot, "db", "knowledge-uploads");

console.log(`[migrate-kb-files] dataRoot=${dataRoot} dryRun=${dryRun}`);

if (!fs.existsSync(mainDbPath)) {
  console.log(`主库不存在: ${mainDbPath},无需迁移`);
  process.exit(0);
}

const main = new DatabaseSync(mainDbPath);
main.exec("PRAGMA journal_mode = WAL");

const tableRow = main
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='uploaded_files'")
  .get();
if (!tableRow) {
  console.log("主库无 uploaded_files 表,无需迁移");
  main.close();
  process.exit(0);
}

const globalRows = main
  .prepare(
    "SELECT id, original_name, stored_name, stored_path, size, mime, uploaded_at FROM uploaded_files WHERE scope_type = 'global'",
  )
  .all();
console.log(`主库 uploaded_files scope=global 行数: ${globalRows.length}`);

if (globalRows.length === 0) {
  console.log("无 global 行。uploads/ 下若仍有孤儿 blob(无对应行)需手动清理。");
  main.close();
  process.exit(0);
}

for (const row of globalRows) {
  console.log(`  - ${row.id}  ${row.original_name}  blob存在=${fs.existsSync(row.stored_path)}`);
}

if (dryRun) {
  console.log("[dry-run] 不执行写入。去掉 DRY_RUN 正式迁移。");
  main.close();
  process.exit(0);
}

// knowledge.db 建 kb_files 表(若后端未启动过则表不存在)
fs.mkdirSync(path.dirname(knowledgeDbPath), { recursive: true });
fs.mkdirSync(newUploadsRoot, { recursive: true });
const kb = new DatabaseSync(knowledgeDbPath);
kb.exec("PRAGMA journal_mode = WAL");
kb.exec(`
  CREATE TABLE IF NOT EXISTS kb_files (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL,
    uploaded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kb_files_uploaded_at ON kb_files(uploaded_at);
`);

const insertKb = kb.prepare(
  "INSERT OR IGNORE INTO kb_files (id, original_name, stored_name, stored_path, size, mime, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
);
const deleteGlobal = main.prepare("DELETE FROM uploaded_files WHERE id = ?");

let migrated = 0;
let blobMissing = 0;
for (const row of globalRows) {
  const storedName = row.stored_name;
  const newPath = path.join(newUploadsRoot, storedName);
  if (fs.existsSync(row.stored_path)) {
    fs.renameSync(row.stored_path, newPath);
  } else {
    blobMissing += 1;
    console.log(`  警告: blob 不存在 ${row.stored_path}(仅迁元数据)`);
  }
  insertKb.run(row.id, row.original_name, storedName, newPath, row.size, row.mime ?? "", row.uploaded_at);
  deleteGlobal.run(row.id);
  migrated += 1;
}

kb.close();
main.close();
console.log(`迁移完成: ${migrated} 行(global→kb_files),blob 缺失 ${blobMissing}`);
console.log(`旧 uploads/ 若已空可手动删除: ${oldUploadsRoot}`);
