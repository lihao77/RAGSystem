import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import YAML from "yaml";

/**
 * 原子写 YAML:先写同目录临时文件,再 rename 覆盖目标。
 * 同卷 rename 在 POSIX 与 Windows 上均为原子操作,避免写盘中途崩溃(OOM/kill/断电)
 * 留下半截文件导致配置损坏、下次启动读到残缺 YAML。
 * 任一步失败时清理临时文件,不残留。
 *
 * 用途:vectorizers.yaml / rerankers.yaml / config.yaml 等 YAML config 的落盘,
 * 替代裸 fs.writeFileSync(YAML.stringify(...))。
 */
export function saveYamlSync(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, YAML.stringify(data), "utf8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件可能尚未创建,或已 rename 走;忽略清理失败。
    }
    throw err;
  }
}
