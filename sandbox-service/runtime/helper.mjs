import fs from "node:fs/promises";
import path from "node:path";

const operation = process.argv[2] ?? "";

try {
  const input = operation === "initialize" ? {} : await readInput();
  const result = await dispatch(operation, input);
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function dispatch(name, input) {
  switch (name) {
    case "initialize": return initialize();
    case "stage-input": return stageInput(input);
    case "read": return readFile(input);
    case "write": return writeFile(input);
    case "edit": return editFile(input);
    case "glob": return globFiles(input);
    case "grep": return grepFiles(input);
    case "preview": return previewFile(input);
    default: throw new Error(`Unsupported sandbox helper operation: ${name}`);
  }
}

async function initialize() {
  await fs.mkdir("/input/uploads", { recursive: true });
  await fs.mkdir("/input/artifacts", { recursive: true });
  await fs.mkdir("/work/transient", { recursive: true });
  // The trusted staging helper owns the volume and needs write permission.
  // The untrusted agent still sees this volume through a read-only mount.
  await fs.chmod("/input", 0o755);
  await fs.chmod("/input/uploads", 0o755);
  await fs.chmod("/input/artifacts", 0o755);
  await fs.chmod("/work/transient", 0o750);
  await fs.chown("/work/transient", 10001, 10001);
  await fs.chmod("/work", 0o750);
  await fs.chown("/work", 10001, 10001);
  return { initialized: true };
}

async function stageInput(input) {
  const filePath = requireString(input.path, "path");
  const resolved = validateAbsolutePath(filePath, ["/input/uploads"]);
  if (input.encoding !== "base64") throw new Error("stage-input requires base64 encoding");
  const content = decodeContent(requireString(input.content, "content"), "base64");
  await ensureWritableTarget(resolved, "/input/uploads");
  await fs.writeFile(resolved, content, { flag: "wx", mode: 0o444 });
  return { size: content.byteLength };
}

async function readFile(input) {
  const resolved = await resolveExisting(requireString(input.path, "path"), ["/input", "/work"]);
  const encoding = normalizeEncoding(input.encoding);
  const maxBytes = optionalInteger(input.maxBytes, 16 * 1024 * 1024, 1, 100 * 1024 * 1024, "maxBytes");
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("Sandbox path is not a file");
  if (stat.size > maxBytes) throw new Error(`Sandbox file exceeds maxBytes ${maxBytes}`);
  const content = await fs.readFile(resolved);
  return { content: content.toString(encoding).replaceAll("\0", ""), size: content.byteLength };
}

async function writeFile(input) {
  const filePath = requireString(input.path, "path");
  const root = writableRoot(filePath);
  const resolved = validateAbsolutePath(filePath, [root]);
  const encoding = normalizeEncoding(input.encoding);
  const content = decodeContent(requireString(input.content, "content"), encoding);
  await ensureWritableTarget(resolved, root);
  await fs.writeFile(resolved, content, { mode: 0o640 });
  return { size: content.byteLength };
}

async function editFile(input) {
  const filePath = requireString(input.path, "path");
  const root = writableRoot(filePath);
  const resolved = await resolveExisting(filePath, [root]);
  const encoding = normalizeEncoding(input.encoding);
  const oldString = requireString(input.oldString, "oldString");
  const newString = requireString(input.newString, "newString", true);
  if (!oldString) throw new Error("oldString cannot be empty");
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Sandbox edit target must be a regular file");
  const original = (await fs.readFile(resolved)).toString(encoding);
  const replaceAll = input.replaceAll === true;
  const replacements = replaceAll ? original.split(oldString).length - 1 : (original.includes(oldString) ? 1 : 0);
  if (!replacements) throw new Error("oldString was not found");
  const edited = replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString);
  const bytes = Buffer.from(edited, encoding);
  await fs.writeFile(resolved, bytes, { mode: 0o640 });
  return { size: bytes.byteLength, replacements };
}

async function globFiles(input) {
  const root = await resolveExistingDirectory(requireString(input.root, "root"));
  const pattern = validateGlob(requireString(input.pattern, "pattern"));
  const recursive = input.recursive === true;
  const maxResults = optionalInteger(input.maxResults, 200, 1, 5000, "maxResults");
  const regex = globToRegExp(pattern);
  const output = [];
  let truncated = false;
  for await (const relativePath of walkFiles(root, recursive ? 5000 : 1)) {
    if (!regex.test(relativePath)) continue;
    if (output.length >= maxResults) {
      truncated = true;
      break;
    }
    output.push(relativePath);
  }
  return { files: output, truncated };
}

async function grepFiles(input) {
  const root = await resolveExistingDirectory(requireString(input.root, "root"));
  const pattern = requireString(input.pattern, "pattern");
  if (pattern.length > 1000) throw new Error("grep pattern is too long");
  const fileGlob = validateGlob(requireString(input.glob, "glob"));
  const fileRegex = globToRegExp(fileGlob);
  const matchRegex = new RegExp(pattern, input.caseSensitive === true ? "" : "i");
  const maxResults = optionalInteger(input.maxResults, 200, 1, 5000, "maxResults");
  const contextLines = optionalInteger(input.contextLines, 0, 0, 20, "contextLines");
  const matches = [];
  let scannedFiles = 0;
  let truncated = false;
  for await (const relativePath of walkFiles(root, 5000)) {
    if (!fileRegex.test(relativePath)) continue;
    const absolutePath = path.posix.join(root, relativePath);
    const stat = await fs.stat(absolutePath);
    if (stat.size > 4 * 1024 * 1024) continue;
    scannedFiles += 1;
    const lines = (await fs.readFile(absolutePath, "utf8")).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!matchRegex.test(lines[index] ?? "")) continue;
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      matches.push({
        file: relativePath,
        lineNumber: index + 1,
        line: lines[index] ?? "",
        before: lines.slice(Math.max(0, index - contextLines), index),
        after: lines.slice(index + 1, index + 1 + contextLines),
      });
    }
    if (truncated) break;
  }
  return { matches, scannedFiles, truncated };
}

async function previewFile(input) {
  const resolved = await resolveExisting(requireString(input.path, "path"), ["/input", "/work"]);
  const maxBytes = optionalInteger(input.maxBytes, 16 * 1024 * 1024, 1, 100 * 1024 * 1024, "maxBytes");
  const maxPreviewRows = optionalInteger(input.maxPreviewRows, 5, 1, 1000, "maxPreviewRows");
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("Sandbox path is not a file");
  if (stat.size > maxBytes) throw new Error(`Sandbox file exceeds maxBytes ${maxBytes}`);
  const extension = path.posix.extname(resolved).toLowerCase();
  const text = await fs.readFile(resolved, "utf8");
  if (extension === ".json") {
    const parsed = JSON.parse(text);
    return { fileType: "json", fileSize: stat.size, structure: summarizeJson(parsed, maxPreviewRows) };
  }
  if (extension === ".csv" || extension === ".tsv") {
    const delimiter = extension === ".tsv" ? "\t" : ",";
    const rows = text.split(/\r?\n/).filter(Boolean).slice(0, maxPreviewRows + 1).map((line) => line.split(delimiter));
    return { fileType: extension.slice(1), fileSize: stat.size, structure: { columns: rows[0] ?? [], preview: rows.slice(1) } };
  }
  return { fileType: extension.slice(1) || "text", fileSize: stat.size, structure: { preview: text.split(/\r?\n/).slice(0, maxPreviewRows) } };
}

async function resolveExisting(rawPath, roots) {
  const normalized = validateAbsolutePath(rawPath, roots);
  const real = await fs.realpath(normalized);
  assertUnderRoots(real, roots);
  return real;
}

async function resolveExistingDirectory(rawPath) {
  const resolved = await resolveExisting(rawPath, ["/input", "/work"]);
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error("Sandbox search root is not a directory");
  return resolved;
}

function validateAbsolutePath(rawPath, roots) {
  if (!rawPath.startsWith("/") || rawPath.includes("\0") || rawPath.split("/").includes("..")) {
    throw new Error("Invalid sandbox path");
  }
  const normalized = path.posix.normalize(rawPath);
  assertUnderRoots(normalized, roots);
  return normalized;
}

function assertUnderRoots(candidate, roots) {
  if (!roots.some((root) => candidate === root || candidate.startsWith(`${root}/`))) {
    throw new Error("Sandbox path is outside the allowed root");
  }
}

function writableRoot(filePath) {
  if (filePath === "/work" || filePath.startsWith("/work/")) return "/work";
  throw new Error("Sandbox write path must be under /work");
}

async function ensureWritableTarget(target, root) {
  const parent = path.posix.dirname(target);
  await fs.mkdir(parent, { recursive: true, mode: 0o750 });
  const realParent = await fs.realpath(parent);
  assertUnderRoots(realParent, [root]);
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink()) throw new Error("Sandbox write target cannot be a symbolic link");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function* walkFiles(root, maxEntries) {
  const pending = [""];
  let entries = 0;
  while (pending.length) {
    const relativeDir = pending.pop();
    const absoluteDir = relativeDir ? path.posix.join(root, relativeDir) : root;
    for (const entry of await fs.readdir(absoluteDir, { withFileTypes: true })) {
      entries += 1;
      if (entries > maxEntries) return;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(relativePath);
      else if (entry.isFile()) yield relativePath;
    }
  }
}

function validateGlob(value) {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || normalized.includes("\0")) {
    throw new Error("Invalid sandbox glob");
  }
  return normalized;
}

function globToRegExp(glob) {
  let output = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          output += "(?:.*/)?";
        } else output += ".*";
      } else output += "[^/]*";
    } else if (char === "?") output += "[^/]";
    else output += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${output}$`);
}

function summarizeJson(value, maxRows) {
  if (Array.isArray(value)) return { kind: "array", length: value.length, preview: value.slice(0, maxRows) };
  if (value && typeof value === "object") return { kind: "object", fields: Object.keys(value), preview: value };
  return { kind: typeof value, value };
}

function normalizeEncoding(value) {
  const encoding = typeof value === "string" ? value.trim().toLowerCase() : "utf-8";
  const normalized = encoding === "utf-8" ? "utf8" : encoding;
  if (!["utf8", "ascii", "latin1", "base64", "hex"].includes(normalized)) throw new Error(`Unsupported encoding: ${encoding}`);
  return normalized;
}

function decodeContent(value, encoding) {
  return Buffer.from(value, encoding);
}

function requireString(value, name, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value)) throw new Error(`${name} must be a string`);
  return value;
}

function optionalInteger(value, fallback, min, max, name) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

async function readInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > 40 * 1024 * 1024) throw new Error("Sandbox helper input is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
