import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach } from "vitest";

/**
 * 测试用临时 db 文件辅助。
 *
 * backend 单连接 ConversationStore 落库（B2:SDK store 已删，落库全归 backend）。
 * 临时文件 db 与生产（文件 db + WAL）行为一致，逼近真实；test 也可改用 :memory:（单连接自洽）。
 */
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    const root = tempRoots.pop()!;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows: db 连接若未显式关闭会锁文件触发 EPERM,跳过(残留临时目录由系统清理)。
    }
  }
});

export function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rag-test-"));
  tempRoots.push(root);
  return root;
}

export function makeTempDb(): string {
  return path.join(makeTempRoot(), "test.db");
}
