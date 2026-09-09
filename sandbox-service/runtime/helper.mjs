import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

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
  // The trusted staging helper owns the volume and needs write permission.
  // The untrusted agent still sees this volume through a read-only mount.
  await fs.chmod("/input", 0o755);
  await fs.chmod("/input/uploads", 0o755);
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

/**
 * ripgrep 内核（与本地 LocalSearchTools/ripgrep-engine.ts 同构）：
 * glob/grep 不再自实现遍历与匹配，spawn 容器内的 rg 二进制。argv 直传
 * （无 shell 层），前置 --no-config 阻断宿主 RIPGREP_CONFIG_PATH 注入；
 * exit 1 = 零匹配的成功；stdout 在 20MB 上限内完整采集，超限/超时显式报错。
 */
/**
 * stdout 上限须低于外层 docker 捕获预算（SANDBOX_MAX_COMMAND_OUTPUT_BYTES，
 * 默认 2MB）：超限时由 helper 先杀进程并显式报"收窄 pattern"错误（stderr 经
 * docker-cli 原样抛出），而不是让 docker 截尾后 JSON 解析失败成笼统 500。
 */
const RAW_OUTPUT_MAX_BYTES = 1_500_000;
const STDERR_MAX_BYTES = 64 * 1024;
const SEARCH_TIMEOUT_MS = 30_000;
const VCS_EXCLUDE_GLOBS = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

function rgBinary() {
  return process.env.RAGSYSTEM_SANDBOX_RG_PATH || "rg";
}

function runRipgrep(argv, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(rgBinary(), ["--no-config", ...argv], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`搜索超时（${SEARCH_TIMEOUT_MS}ms），请收窄 pattern/path/glob`));
      child.kill("SIGKILL");
    }, SEARCH_TIMEOUT_MS);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
    child.stdout.on("data", (chunk) => {
      if (stdoutBytes + chunk.byteLength > RAW_OUTPUT_MAX_BYTES) {
        finish(new Error(`搜索原始输出超过 ${RAW_OUTPUT_MAX_BYTES} 字节上限，请收窄 pattern/path/glob`));
        child.kill("SIGKILL");
        return;
      }
      stdoutBytes += chunk.byteLength;
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes + chunk.byteLength <= STDERR_MAX_BYTES) {
        stderrBytes += chunk.byteLength;
        stderrChunks.push(chunk);
      }
    });
    child.on("error", (error) => finish(new Error(`ripgrep 启动失败: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      if (signal !== null) {
        reject(new Error(`搜索进程被信号 ${signal} 终止`));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code === 0 || code === 1) {
        resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), noMatches: code === 1 });
        return;
      }
      if (/regex parse error|error parsing glob/i.test(stderr)) {
        reject(new Error(`pattern/glob 被 ripgrep 拒绝: ${stderr}`));
        return;
      }
      reject(new Error(`ripgrep 执行失败（exit ${code}）${stderr ? `: ${stderr}` : ""}`));
    });
  });
}

async function globFiles(input) {
  const root = await resolveExistingDirectory(requireString(input.root, "root"));
  const pattern = validateGlob(requireString(input.pattern, "pattern"));
  const maxResults = optionalInteger(input.maxResults, 100, 1, 5000, "maxResults");
  const argv = ["--files", `--glob=${pattern}`, "--sort=modified", "--no-ignore", "--hidden"];
  for (const name of VCS_EXCLUDE_GLOBS) argv.push(`--glob=!**/${name}`, `--glob=!**/${name}/**`);
  argv.push("--", ".");
  const run = await runRipgrep(argv, root);
  const all = run.noMatches ? [] : run.stdout.split("\n").filter(Boolean).map(normalizeRipgrepPath);
  return { files: all.slice(0, maxResults), truncated: all.length > maxResults, totalFiles: all.length };
}

async function grepFiles(input) {
  const root = await resolveExistingDirectory(requireString(input.root, "root"));
  const pattern = requireString(input.pattern, "pattern");
  if (pattern.length > 1000) throw new Error("grep pattern is too long");
  const fileGlob = validateGlob(requireString(input.glob, "glob"));
  const caseSensitive = input.caseSensitive !== false;
  const maxResults = optionalInteger(input.maxResults, 250, 1, 5000, "maxResults");
  const contextLines = optionalInteger(input.contextLines, 0, 0, 20, "contextLines");
  const argv = ["--json", `--regexp=${pattern}`];
  if (!caseSensitive) argv.push("--ignore-case");
  if (fileGlob !== "**/*") argv.push(`--glob=${fileGlob}`);
  if (contextLines > 0) argv.push(`--context=${contextLines}`);
  // 显式包含隐藏文件（受管工作区不是源码仓库），VCS 元数据目录永远排除。
  argv.push("--hidden");
  for (const name of VCS_EXCLUDE_GLOBS) argv.push(`--glob=!**/${name}`, `--glob=!**/${name}/**`);
  argv.push("--", ".");
  const run = await runRipgrep(argv, root);
  // 零匹配（exit 1）时 rg 仍输出带 stats.searches 的 summary，照常解析以如实上报扫描数。
  const parsed = parseGrepJson(run.stdout, contextLines);
  return {
    matches: parsed.matches.slice(0, maxResults),
    scannedFiles: parsed.scannedFiles,
    truncated: parsed.matches.length > maxResults,
    totalMatches: parsed.matches.length,
  };
}

function parseGrepJson(stdout, contextLines) {
  const matches = [];
  let scannedFiles = 0;
  let pendingBefore = [];
  let lastAfterBuffer = null;
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new Error("grep 收到畸形 ripgrep --json 输出（非 JSON 行）");
    }
    if (record.type === "summary") {
      if (typeof record.data?.stats?.searches === "number") scannedFiles = record.data.stats.searches;
      continue;
    }
    if (record.type === "begin") {
      pendingBefore = [];
      lastAfterBuffer = null;
      continue;
    }
    if (record.type === "context") {
      const line = recordLineText(record);
      if (line === undefined) continue;
      pendingBefore.push(line);
      if (lastAfterBuffer) lastAfterBuffer.push(line);
      continue;
    }
    if (record.type !== "match") continue;
    const line = recordLineText(record);
    if (line === undefined || typeof record.data?.line_number !== "number" || typeof record.data?.path?.text !== "string") {
      throw new Error("grep 收到畸形 ripgrep --json 输出（match 记录缺字段）");
    }
    const after = [];
    matches.push({
      file: normalizeRipgrepPath(record.data.path.text),
      lineNumber: record.data.line_number,
      line,
      before: contextLines > 0 ? pendingBefore.slice(-contextLines) : [],
      after,
    });
    lastAfterBuffer = after;
    pendingBefore = [];
  }
  // 远距匹配间的 context 行会同时流进前一匹配的 after 缓冲，定稿时取前 N 行（见 TS 内核同名注释）。
  if (contextLines > 0) {
    for (const match of matches) {
      if (match.after.length > contextLines) match.after = match.after.slice(0, contextLines);
    }
  }
  matches.sort((left, right) =>
    left.file === right.file ? left.lineNumber - right.lineNumber : left.file.localeCompare(right.file),
  );
  return { matches, scannedFiles };
}

function recordLineText(record) {
  const lines = record.data?.lines;
  if (!lines || typeof lines !== "object") return undefined;
  if (typeof lines.text === "string") return lines.text.replace(/\r?\n$/, "");
  if (typeof lines.bytes === "string") return "(line is not valid UTF-8)";
  return undefined;
}

function normalizeRipgrepPath(value) {
  let normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
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

function validateGlob(value) {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || normalized.includes("\0")) {
    throw new Error("Invalid sandbox glob");
  }
  return normalized;
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
