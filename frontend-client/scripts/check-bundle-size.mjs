import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(scriptDir, "..", "dist", "assets");
const maxChunkBytes = 450 * 1024;
const maxTotalBytes = 2.2 * 1024 * 1024;

if (!fs.existsSync(assetsDir)) {
  throw new Error(`Bundle assets not found: ${assetsDir}. Run the frontend build first.`);
}

const chunks = fs.readdirSync(assetsDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => ({ name, bytes: fs.statSync(path.join(assetsDir, name)).size }))
  .sort((left, right) => right.bytes - left.bytes);
const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
const oversized = chunks.filter((chunk) => chunk.bytes > maxChunkBytes);

if (oversized.length > 0 || totalBytes > maxTotalBytes) {
  const details = oversized.map((chunk) => `${chunk.name}=${formatKiB(chunk.bytes)}`).join(", ");
  throw new Error(
    `Frontend bundle budget exceeded: max chunk ${formatKiB(maxChunkBytes)}, total ${formatMiB(maxTotalBytes)}; `
    + `actual total ${formatMiB(totalBytes)}${details ? `; oversized ${details}` : ""}`,
  );
}

console.log(
  `Frontend bundle budget passed: largest ${chunks[0]?.name ?? "none"}=${formatKiB(chunks[0]?.bytes ?? 0)}, `
  + `total=${formatMiB(totalBytes)}`,
);

function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
