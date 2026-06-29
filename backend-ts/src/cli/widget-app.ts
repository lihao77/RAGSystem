#!/usr/bin/env tsx
/**
 * widget 应用凭证管理 CLI：创建/吊销 widget app（app-key/secret 对）。
 *
 * 用法（位置参数——避免 npm/npx 吞 --flag）：
 *   npx tsx src/cli/widget-app.ts create <名称> [来源1,来源2,...]
 *   npx tsx src/cli/widget-app.ts revoke <app_key>
 *
 * 例：
 *   npm -w backend-ts exec tsx src/cli/widget-app.ts create demo http://localhost:4321
 *
 * create 成功后 secret 仅显示一次——后端只存 SHA-256 hash，无法找回，请立即保存。
 */
import { loadEnv } from "../config/env.js";
import { createWidgetCredentialStore } from "../services/stores/widget-credential-store/index.js";

function main(): void {
  const [, , command, ...rest] = process.argv;
  if (command !== "create" && command !== "revoke") {
    usage();
    process.exit(1);
  }

  const env = loadEnv(process.env);
  const store = createWidgetCredentialStore({ dbPath: env.dbPath });
  try {
    if (command === "create") {
      const name = rest[0];
      if (!name) {
        usage();
        process.exit(1);
      }
      const origins = (rest[1] ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const created = store.ops.createApp({ display_name: name, allowed_origins: origins });
      console.log(JSON.stringify(created, null, 2));
      console.error("\n⚠️  secret 仅此一次显示，请立即保存（后端只存 hash）。");
    } else {
      const appKey = rest[0];
      if (!appKey) {
        usage();
        process.exit(1);
      }
      const ok = store.ops.revokeApp(appKey);
      console.log(ok ? `已吊销 ${appKey}` : `未找到或已吊销：${appKey}`);
    }
  } finally {
    store.close();
  }
}

function usage(): void {
  console.error(
    [
      "用法（位置参数）:",
      "  create <名称> [来源1,来源2,...]   例: create demo http://localhost:4321",
      "  revoke <app_key>",
    ].join("\n"),
  );
}

main();
