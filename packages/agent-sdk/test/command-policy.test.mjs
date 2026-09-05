import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApprovalDescription,
  categoryRisk,
  classifyCommand,
  validateCommand,
  COMMAND_SUBSTITUTION_MARKER,
} from "../dist/tools/command-policy.js";

test("read-only chains run without approval", () => {
  const result = validateCommand("grep -rn foo src && ls -la");
  assert.equal(result.status, "allowed");
  assert.equal(result.category, "read_only");
  assert.deepEqual(result.approvalCommands, []);
});

test("newlines split the chain instead of being blocked", () => {
  const plain = validateCommand("ls\npwd");
  assert.equal(plain.status, "allowed");
  assert.equal(plain.category, "read_only");

  const mixed = validateCommand("ls\ngit status");
  assert.equal(mixed.status, "approval_required");
  assert.equal(mixed.category, "network");
  assert.ok(mixed.approvalCommands.includes("git"));

  const continued = validateCommand("grep foo \\\n  src");
  assert.equal(continued.status, "allowed");
});

test("write redirection requires approval instead of being blocked", () => {
  const write = validateCommand("echo hi > out.txt");
  assert.equal(write.status, "approval_required");
  assert.equal(write.category, "write");
  assert.deepEqual(write.approvalCommands, [">"]);

  const append = validateCommand("echo hi >> out.txt");
  assert.equal(append.status, "approval_required");
  assert.deepEqual(append.approvalCommands, [">>"]);

  const fdWrite = validateCommand("ls 1> out.txt");
  assert.equal(fdWrite.status, "approval_required");
  assert.ok(fdWrite.approvalCommands.includes(">"));

  const discarded = validateCommand("ls 2>/dev/null > /dev/null");
  assert.equal(discarded.status, "allowed");

  const quoted = validateCommand("sed 's/>/x/' file");
  assert.equal(quoted.status, "allowed");

  // /dev/null 豁免要求整词匹配：前缀拼接出的是真实文件名。
  const nullPrefix = validateCommand("echo data > /dev/nullabc");
  assert.equal(nullPrefix.status, "approval_required");
  assert.equal(nullPrefix.category, "write");

  const nullPrefixStderr = validateCommand("ls 2> /dev/null-secret");
  assert.equal(nullPrefixStderr.status, "approval_required");

  // N>&M / N>&- 是 fd 复制/关闭，不是写文件。
  const dupStderr = validateCommand("grep pattern file 1>&2");
  assert.equal(dupStderr.status, "allowed");

  const dupShorthand = validateCommand("grep pattern file >&2");
  assert.equal(dupShorthand.status, "allowed");

  const mergeStderr = validateCommand("grep pattern file 2>&1");
  assert.equal(mergeStderr.status, "allowed");
});

test("command substitution forces approval and cannot smuggle through a read-only wrapper", () => {
  const subst = validateCommand("echo $(date)");
  assert.equal(subst.status, "approval_required");
  assert.equal(subst.category, "interpreter");
  assert.deepEqual(subst.approvalCommands, [COMMAND_SUBSTITUTION_MARKER]);

  const smuggle = validateCommand("echo $(rm -rf /tmp/x)");
  assert.equal(smuggle.status, "approval_required");
  assert.equal(smuggle.category, "interpreter");

  const backtick = validateCommand("echo `whoami`");
  assert.equal(backtick.status, "approval_required");
  assert.equal(backtick.category, "interpreter");

  const processSubst = validateCommand("cat <(rm -rf /tmp/x)");
  assert.equal(processSubst.status, "approval_required");
  assert.equal(processSubst.category, "interpreter");
  assert.deepEqual(processSubst.approvalCommands, [COMMAND_SUBSTITUTION_MARKER]);

  const literal = validateCommand("echo '$(not substitution)'");
  assert.equal(literal.status, "allowed");

  const escaped = validateCommand("echo \\$(date)");
  assert.equal(escaped.status, "allowed");
});

test("PATH-style env overrides require approval while hijack vars stay blocked", () => {
  const pathOverride = validateCommand("PATH=/opt/bin ls");
  assert.equal(pathOverride.status, "approval_required");
  assert.ok(pathOverride.approvalCommands.includes("PATH="));

  const pythonOverride = validateCommand("PYTHONPATH=/x python -c 'pass'");
  assert.equal(pythonOverride.status, "approval_required");
  assert.ok(pythonOverride.approvalCommands.includes("PYTHONPATH="));

  const ldPreload = validateCommand("LD_PRELOAD=./evil.so ls");
  assert.equal(ldPreload.status, "blocked");

  const bashEnv = validateCommand("BASH_ENV=./evil.sh sh -c true");
  assert.equal(bashEnv.status, "blocked");
});

test("parser-fidelity hard blocks remain", () => {
  assert.equal(validateCommand("rm -rf {a..z}").status, "blocked");
  assert.equal(validateCommand("cat /proc/self/environ").status, "blocked");
  assert.equal(validateCommand("IFS='x' ls").status, "blocked");
  assert.equal(validateCommand("ls\u00a0-la").status, "blocked");
  assert.equal(validateCommand("printf 'a\u0001b'").status, "blocked");
});

test("approval description flags substitution as high risk", () => {
  const validation = validateCommand("echo $(date)");
  const dangerous = validation.approvalCommands.filter((name) =>
    name === COMMAND_SUBSTITUTION_MARKER ||
    ["destructive", "network", "interpreter"].includes(classifyCommand(name)),
  );
  assert.deepEqual(dangerous, [COMMAND_SUBSTITUTION_MARKER]);
  const description = buildApprovalDescription({
    command: "echo $(date)",
    description: "",
    category: validation.category,
    dangerousCommands: dangerous,
  });
  assert.ok(description.includes("高风险"));
});

test("per-command classification semantics are unchanged", () => {
  assert.equal(classifyCommand("sed", ["sed", "-i", "s/a/b/", "f"]), "write");
  assert.equal(classifyCommand("sed", ["sed", "s/a/b/", "f"]), "read_only");
  assert.equal(classifyCommand("tar", ["tar", "-tf", "a.tar"]), "read_only");
  assert.equal(classifyCommand("git", ["git", "status"]), "network");
  assert.equal(categoryRisk("read_only"), "low");
  assert.equal(categoryRisk("unknown"), "medium");
  assert.equal(categoryRisk("interpreter"), "high");
  assert.equal(categoryRisk("destructive"), "high");
});

test("single & chains are split so chained commands cannot bypass classification", () => {
  // cmd 无条件顺序执行 / bash 后台执行：& 之后的命令必须逐段分类。
  const destructive = validateCommand("echo harmless & del /q important.txt");
  assert.equal(destructive.status, "approval_required");
  assert.equal(destructive.category, "destructive");
  assert.ok(destructive.approvalCommands.includes("del"));

  // && 语义不变（回归）。
  const andAlso = validateCommand("echo harmless && del /q important.txt");
  assert.equal(andAlso.status, "approval_required");
  assert.equal(andAlso.category, "destructive");

  // 两侧都是只读命令时 & 串联不触发审批（不引入新的误报）。
  const harmless = validateCommand("echo A & echo B");
  assert.equal(harmless.status, "allowed");
  assert.equal(harmless.category, "read_only");

  // 引号内的 & 是字面量，不是链分隔符。
  const quoted = validateCommand("grep 'a & b' file");
  assert.equal(quoted.status, "allowed");

  // fd 复制/整体重定向中的 & 属于重定向语法，不得误拆（2>&1 保持放行）。
  const dup = validateCommand("grep pattern file 2>&1 & echo done");
  assert.equal(dup.status, "allowed");
  const redirectAll = validateCommand("cmd &> out.log");
  assert.equal(redirectAll.status, "approval_required");
  assert.ok(redirectAll.approvalCommands.includes(">"));
});

test("windows ampersand mode treats backslash-escaped and single-quoted & as separators", () => {
  const windows = { windowsAmpersand: true };
  // cmd 下 \ 不是转义：`\&` 仍是分隔符，del 不得逃过审批。
  const escaped = validateCommand("echo a\\&del x", windows);
  assert.equal(escaped.status, "approval_required");
  assert.equal(escaped.category, "destructive");
  assert.ok(escaped.approvalCommands.includes("del"));

  // cmd 下单引号不是引号：引号内的 & 之后的破坏性命令同样拆段。
  const singleQuoted = validateCommand("echo 'harmless & rd /s data'", windows);
  assert.equal(singleQuoted.status, "approval_required");
  assert.ok(singleQuoted.approvalCommands.includes("rd"));

  // 双引号在 cmd 下是真实引号：字面量 & 不拆。
  const doubleQuoted = validateCommand("echo \"a & b\"", windows);
  assert.equal(doubleQuoted.status, "allowed");

  // fd 复制豁免在 windows 模式下不变。
  const dup = validateCommand("grep pattern file 2>&1 & echo done", windows);
  assert.equal(dup.status, "allowed");

  // POSIX 默认语义不变：`\&` 与单引号内的 & 是字面量，不拆。
  assert.equal(validateCommand("echo a\\&del x").status, "allowed");
  assert.equal(validateCommand("grep 'a & b' file").status, "allowed");
});

test("cmd recursive delete and Windows system commands classify correctly", () => {
  // rd/rmdir 带 /s 是 cmd 递归删除；不带 /s 归写操作。
  assert.equal(classifyCommand("rd", ["rd", "/s", "/q", "dist"]), "destructive");
  assert.equal(classifyCommand("rmdir", ["rmdir", "/s", "dist"]), "destructive");
  assert.equal(classifyCommand("rmdir", ["rmdir", "empty-dir"]), "write");
  assert.equal(classifyCommand("rd", ["rd", "empty-dir"]), "write");
  assert.equal(validateCommand("rd /s /q C:\\data").category, "destructive");

  // Windows 系统状态/能力命令归解释器（高风险 + 审批）。
  assert.equal(classifyCommand("reg", ["reg", "delete", "HKLM\\X"]), "interpreter");
  assert.equal(classifyCommand("taskkill", ["taskkill", "/f", "/im", "x.exe"]), "interpreter");
  assert.equal(classifyCommand("schtasks", ["schtasks", "/create", "/tn", "x"]), "interpreter");
  assert.equal(validateCommand("reg delete HKLM\\Software\\X /f").status, "approval_required");
  assert.equal(validateCommand("reg delete HKLM\\Software\\X /f").category, "interpreter");
});
