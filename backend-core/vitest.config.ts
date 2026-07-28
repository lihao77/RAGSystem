import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    conditions: ["node"],
    alias: [
      {
        find: /^@ragsystem\/backend-core\/(.*)\.js$/,
        replacement: path.resolve(root, "src/$1.ts"),
      },
      {
        find: /^@ragsystem\/backend-local\/(.*)\.js$/,
        replacement: path.resolve(root, "../backend-local/src/$1.ts"),
      },
      {
        find: /^@ragsystem\/backend-saas\/(.*)\.js$/,
        replacement: path.resolve(root, "../backend-saas/src/$1.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    pool: "forks",
    server: {
      deps: {
        external: ["node:sqlite"],
      },
    },
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
