import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["node"],
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
