import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach } from "vitest";

/**
 * 测试用临时 db 文件辅助。
 *
 * conversationStore 与 sdkStore 是两个独立 SQLite 连接(记忆:sdk-store-realigned,
 * 双连接 WAL)。用各自的 ":memory:" 会得到两个不共享的内存库,导致 sdkStore 落的
 * run/message 在 conversationStore 侧读不到。改用临时文件:两连接经 WAL 共享同一
 * 数据库文件,与生产(文件 db)行为一致。
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
