import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { outputFolder: "test-results/playwright-report", open: "never" }]],
  outputDir: "test-results/playwright",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4327",
    browserName: "chromium",
    headless: true,
    viewport: { width: 1672, height: 941 },
    screenshot: "off",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node --experimental-strip-types ../backend/test/browser-server.ts",
    url: "http://127.0.0.1:4327/",
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
