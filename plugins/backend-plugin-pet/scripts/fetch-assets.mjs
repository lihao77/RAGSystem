// 拉取 dsh-pet npm 包并抽取播放用动画到本包 assets/thumb。
// 素材（约 50MB webm）不入 git，首次使用或更新素材时执行：npm run fetch-assets
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-pet-assets-"));

try {
  console.log("npm pack dsh-pet ...");
  execFileSync("npm", ["pack", "dsh-pet", "--pack-destination", tmp], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const archive = fs.readdirSync(tmp).find((name) => name.endsWith(".tgz"));
  if (!archive) throw new Error("npm pack 未产出 tgz");
  // 相对路径解压：GNU tar 会把 "C:\..." 的冒号解析为远程主机名，须避开盘符绝对路径
  execFileSync("tar", ["-xzf", archive, "-C", "."], {
    stdio: "inherit",
    shell: process.platform === "win32",
    cwd: tmp,
  });

  // dsh-pet 0.2.0 起播放素材目录由 assets/thumb 改名 assets/webm（双格式发布）
  const source = ["package/assets/webm", "package/assets/thumb"]
    .map((candidate) => path.join(tmp, candidate))
    .find((candidate) => fs.existsSync(candidate));
  if (!source) throw new Error(`dsh-pet 包内未找到素材目录（assets/webm 或 assets/thumb）：${path.join(tmp, "package", "assets")}`);
  fs.rmSync(path.join(pkgRoot, "assets"), { recursive: true, force: true });
  fs.mkdirSync(path.join(pkgRoot, "assets"), { recursive: true });
  fs.cpSync(source, path.join(pkgRoot, "assets", "thumb"), { recursive: true });
  console.log(`已安装 ${fs.readdirSync(path.join(pkgRoot, "assets", "thumb")).length} 个 thumb 动画`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
