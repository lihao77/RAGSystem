#!/usr/bin/env tsx
/**
 * widget 应用凭证管理 CLI：创建/吊销 widget app（app-key/secret 对）。
 *
 * 用法：
 *   npx tsx src/cli/widget-app.ts create --name "我的网站" --origins https://a.com,https://b.com
 *   npx tsx src/cli/widget-app.ts revoke --app-key wid_pk_xxx
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
      const name = option(rest, "--name");
      if (!name) {
        usage();
        process.exit(1);
      }
      const origins =
        option(rest, "--origins")
          ?.split(",")
          .map((item) => item.trim())
          .filter(Boolean) ?? [];
      const created = store.ops.createApp({ display_name: name, allowed_origins: origins });
      console.log(JSON.stringify(created, null, 2));
      console.error('\n⚠️  secret 仅此一次显示，请立即保存（后端只存 hash）。');
    } else {
      const appKey = option(rest, "--app-key");
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

function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): void {
  console.error(
    [
      "用法:",
      "  create --name <名称> [--origins <逗号分隔的允许来源>]",
      "  revoke --app-key <app_key>",
    ].join("\n"),
  );
}

main();
