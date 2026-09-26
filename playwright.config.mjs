import { defineConfig, chromium } from "@playwright/test";
export default defineConfig({
  testDir: "test/e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 30000,
  reporter: "list",
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: { executablePath: chromium.executablePath() },
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
  },
});
