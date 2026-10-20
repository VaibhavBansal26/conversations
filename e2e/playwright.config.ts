import { defineConfig } from "@playwright/test";

// One random port per run, shared with the workers through the environment (they re-evaluate this file).
process.env.E2E_PORT ??= String(43000 + Math.floor(Math.random() * 5000));
const port = Number(process.env.E2E_PORT);
export const BASE_URL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  // The built server (server/dist + web/dist) with a throwaway SQLite database and the demo seed.
  webServer: { command: "node support/stack.mjs", url: `${BASE_URL}/healthz`, env: { E2E_PORT: String(port) }, reuseExistingServer: !!process.env.E2E_REUSE, timeout: 90_000, stdout: "ignore" },
  use: {
    baseURL: BASE_URL,
    // Uses the Chrome that is already installed (no browser download); set E2E_CHANNEL= to use Playwright's own Chromium instead.
    channel: process.env.E2E_CHANNEL === undefined ? "chrome" : process.env.E2E_CHANNEL || undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "UTC",
  },
  projects: [
    { name: "app", testIgnore: /shots\.spec\.ts/ },
    { name: "shots", testMatch: /shots\.spec\.ts/ },
  ],
});
