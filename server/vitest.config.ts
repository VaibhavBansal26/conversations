import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    pool: "forks",
    globalSetup: ["tests/global-setup.ts"],
  },
});
