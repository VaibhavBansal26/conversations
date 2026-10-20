import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: process.env.TEST_DB === "postgres" || process.env.TEST_REDIS ? 60000 : 20000,
    hookTimeout: 60000,
    pool: "forks",
    globalSetup: ["tests/global-setup.ts"],
  },
});
