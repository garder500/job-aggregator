import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  timeout: 45000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8787",
    headless: true,
  },
  reporter: "list",
  webServer: {
    command: "node --import tsx scripts/test-server.ts",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: false,
    timeout: 120000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
  },
});
