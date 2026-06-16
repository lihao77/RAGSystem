import path from "node:path";

import type { RiskLevel } from "../../contracts/permissions.js";

export type CommandCategory = "read_only" | "write" | "destructive" | "network" | "interpreter" | "unknown";
type ValidationStatus = "allowed" | "approval_required" | "blocked";

const READ_ONLY_COMMANDS = new Set([
  "grep", "find", "cat", "ls", "head", "tail", "wc",
  "echo", "sort", "uniq", "cut", "awk", "diff", "comm",
  "paste", "column", "tr", "xargs",
  "pwd", "which", "whereis", "realpath", "dirname", "basename",
  "file", "stat", "du", "df",
  "env", "printenv", "date", "uname", "id", "whoami",
  "ps", "top", "htop", "free", "uptime",
  "less", "more", "strings", "od", "xxd",
  "md5sum", "sha1sum", "sha256sum",
  "jq", "yq", "xmllint",
]);

const WRITE_COMMANDS = new Set([
  "cp", "mv", "mkdir", "rmdir", "touch", "chmod", "chown",
  "ln", "tee", "install", "sed", "tar", "zip", "unzip", "gzip", "gunzip",
]);

const DESTRUCTIVE_COMMANDS = new Set(["rm", "dd", "shred", "wipe", "format", "mkfs", "del", "fdisk", "parted", "truncate"]);
const NETWORK_COMMANDS = new Set(["curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "netcat", "ncat", "telnet", "ftp", "ping", "traceroute", "nslookup", "dig", "git", "svn", "hg"]);
const INTERPRETER_COMMANDS = new Set([
  "python", "python3", "python2",
  "node", "nodejs", "deno", "bun",
  "ruby", "perl", "php", "lua",
  "bash", "sh", "zsh", "fish", "dash", "ksh",
  "powershell", "pwsh", "cmd",
  "java", "javac", "scala", "groovy",
  "go", "rustc", "cargo",
  "npm", "yarn", "pnpm", "pip", "pip3",
  "make", "cmake", "ninja",
  "docker", "podman", "kubectl", "helm",
  "sudo", "su", "doas",
  "kill", "pkill", "killall",
  "shutdown", "reboot", "halt", "poweroff",
  "crontab", "at", "batch",
  "mount", "umount",
  "iptables", "ufw", "firewall-cmd",
  "systemctl", "service", "init",
  "useradd", "userdel", "usermod", "passwd", "groupadd",
]);

export function validateCommand(command: string): {
  status: ValidationStatus;
  error: string;
  approvalCommands: string[];
  category: CommandCategory;
} {
  const securityError = validateCommandSecurity(command);
  if (securityError) {
    return {
      status: "blocked",
      error: securityError,
      approvalCommands: [],
      category: "unknown",
    };
  }

  const approvalCommands: string[] = [];
  const categories: CommandCategory[] = [];
  for (const segment of splitShellChain(command)) {
    const tokens = shellSplit(segment.trim());
    if (!tokens.length) {
      continue;
    }
    const commandName = path.basename(tokens[0]!);
    const category = classifyCommand(commandName, tokens);
    categories.push(category);
    if (category !== "read_only" && !approvalCommands.includes(commandName)) {
      approvalCommands.push(commandName);
    }
  }
  const category = highestCategory(categories);
  if (approvalCommands.length) {
    return {
      status: "approval_required",
      error: `命令需要用户审批后才能执行: ${approvalCommands.join(", ")}`,
      approvalCommands,
      category,
    };
  }
  return {
    status: "allowed",
    error: "",
    approvalCommands,
    category,
  };
}

export function classifyCommand(commandName: string, tokens: string[] = []): CommandCategory {
  const name = path.basename(commandName).toLowerCase();
  const args = tokens.slice(1);
  const shortFlags = new Set<string>();
  const longFlags = new Set<string>();
  for (const arg of args) {
    if (arg.startsWith("--")) {
      longFlags.add(arg.replace(/^-+/, ""));
    } else if (arg.startsWith("-") && arg.length > 1) {
      for (const char of arg.slice(1)) {
        shortFlags.add(char);
      }
    }
  }

  if (name === "sed") {
    return shortFlags.has("i") || args.some((arg) => arg === "-i" || (arg.startsWith("-i") && !arg.startsWith("--")))
      ? "write"
      : "read_only";
  }
  if (name === "tar") {
    const writeOps = hasAny(shortFlags, ["x", "c", "r", "u", "d", "A"]) || hasAny(longFlags, ["extract", "get", "create", "append", "update", "delete", "concatenate"]);
    const listOps = shortFlags.has("t") || longFlags.has("list");
    return listOps && !writeOps ? "read_only" : "write";
  }
  if (name === "zip") {
    return shortFlags.has("l") || longFlags.has("list") || longFlags.has("show-stored-files") ? "read_only" : "write";
  }
  if (name === "unzip") {
    return shortFlags.has("l") || shortFlags.has("v") ? "read_only" : "write";
  }
  if (name === "gzip") {
    return shortFlags.has("l") || shortFlags.has("t") || longFlags.has("list") || longFlags.has("test") ? "read_only" : "write";
  }
  if (name === "gunzip") {
    return "write";
  }
  if (INTERPRETER_COMMANDS.has(name)) {
    return "interpreter";
  }
  if (DESTRUCTIVE_COMMANDS.has(name) || name.startsWith("mkfs.")) {
    return "destructive";
  }
  if (NETWORK_COMMANDS.has(name)) {
    return "network";
  }
  if (WRITE_COMMANDS.has(name)) {
    return "write";
  }
  if (READ_ONLY_COMMANDS.has(name)) {
    return "read_only";
  }
  return "unknown";
}

export function categoryRisk(category: CommandCategory): RiskLevel {
  if (category === "read_only") {
    return "low";
  }
  if (category === "write" || category === "unknown") {
    return "medium";
  }
  return "high";
}

export function buildApprovalDescription(input: {
  command: string;
  description: string;
  category: CommandCategory;
  dangerousCommands: string[];
}): string {
  let description = `execute_bash 申请执行${categoryLabel(input.category)}：${input.description || input.command.slice(0, 120)}`;
  if (input.dangerousCommands.length) {
    description += "。高风险命令可能导致删除文件、下载远程内容、启动解释器/子 shell 或影响系统状态。";
  }
  return description;
}

function validateCommandSecurity(command: string): string | null {
  const stripped = command.replace(/2>\s*\/dev\/null|2>&1/g, "");
  if (stripped.includes("$(") || stripped.includes("`")) {
    return "禁止命令替换: $() 或反引号";
  }
  if (/(?<![12&])>(?!>?\s*\/dev\/null)/.test(stripped)) {
    return "禁止写重定向操作符: > 或 >>";
  }
  if (/\bIFS\s*=/.test(stripped)) {
    return "禁止修改 IFS 变量";
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) {
    return "禁止包含控制字符或 null byte";
  }
  if (/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/.test(command)) {
    return "禁止包含 Unicode 伪空格字符";
  }
  if (/--?\w+=.*\$\(|--?\w+=.*`/.test(stripped)) {
    return "禁止在 flag 参数中嵌入命令替换";
  }
  if (/\b(?:PATH|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONPATH|DYLD_INSERT_LIBRARIES|IFS|BASH_ENV|ENV|PROMPT_COMMAND|PS1|PS2)\s*=/.test(stripped)) {
    return "禁止修改危险环境变量（PATH/LD_PRELOAD 等）";
  }
  if (command.includes("\n") || command.includes("\r")) {
    return "禁止在命令中包含换行符";
  }
  if (/\{[^}]*\.\.[^}]*\}/.test(stripped)) {
    return "禁止花括号展开中包含路径穿越";
  }
  if (/\/proc\/[^/]*\/environ/.test(stripped)) {
    return "禁止访问 /proc/*/environ";
  }
  if (/\\[\n\r]/.test(command)) {
    return "禁止反斜杠转义换行";
  }
  return null;
}

function splitShellChain(command: string): string[] {
  const chainSegments = splitByShellOperators(command, ["&&", "||", ";"]);
  return chainSegments.flatMap((segment) => splitShellPipeline(segment));
}

function splitShellPipeline(command: string): string[] {
  return splitByShellOperators(command, ["|"]);
}

function splitByShellOperators(command: string, operators: string[]): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && !inSingle) {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      current += char;
      continue;
    }
    if (char === "\"" && !inSingle) {
      inDouble = !inDouble;
      current += char;
      continue;
    }
    if (!inSingle && !inDouble) {
      const matched = operators.find((operator) => command.slice(index, index + operator.length) === operator);
      if (matched) {
        segments.push(current);
        current = "";
        index += matched.length - 1;
        continue;
      }
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

function shellSplit(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function highestCategory(categories: CommandCategory[]): CommandCategory {
  const order: CommandCategory[] = ["read_only", "write", "unknown", "network", "interpreter", "destructive"];
  let highest: CommandCategory = "read_only";
  for (const category of categories) {
    if (order.indexOf(category) > order.indexOf(highest)) {
      highest = category;
    }
  }
  return highest;
}

function categoryLabel(category: CommandCategory): string {
  return {
    read_only: "只读命令",
    write: "写操作命令",
    destructive: "破坏性命令",
    network: "网络命令",
    interpreter: "解释器/系统控制命令",
    unknown: "未知命令",
  }[category];
}

function hasAny(values: Set<string>, candidates: string[]): boolean {
  return candidates.some((candidate) => values.has(candidate));
}
