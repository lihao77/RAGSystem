// 拉取 dsh-pet npm 包并抽取 thumb 动画到本包 assets/thumb。
// 素材（约 35MB webm）不入 git，首次使用或更新素材时执行：npm run fetch-assets
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
  execFileSync("tar", ["-xzf", path.join(tmp, archive), "-C", tmp], { stdio: "inherit" });

  const source = path.join(tmp, "package", "assets", "thumb");
  if (!fs.existsSync(source)) throw new Error(`dsh-pet 包内未找到素材目录：${source}`);
  fs.rmSync(path.join(pkgRoot, "assets"), { recursive: true, force: true });
  fs.mkdirSync(path.join(pkgRoot, "assets"), { recursive: true });
  fs.cpSync(source, path.join(pkgRoot, "assets", "thumb"), { recursive: true });
  console.log(`已安装 ${fs.readdirSync(path.join(pkgRoot, "assets", "thumb")).length} 个 thumb 动画`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
