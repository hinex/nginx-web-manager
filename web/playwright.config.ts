import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testData = resolve(__dirname, "e2e", ".test-data");
const fixturesDir = resolve(__dirname, "e2e", "fixtures");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "html",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  webServer: {
    command: "sh e2e/start-server.sh",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    env: {
      DB_PATH: resolve(testData, "db.sqlite"),
      NGINX_CONF_DIR: resolve(testData, "nginx"),
      DATA_NGINX_DIR: resolve(testData, "data", "nginx"),
      PATH: `${fixturesDir}:${process.env.PATH}`,
    },
  },
});
