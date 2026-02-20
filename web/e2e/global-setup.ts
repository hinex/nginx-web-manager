import { execSync } from "child_process";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TEST_DATA = resolve(__dirname, ".test-data");

export default async function globalSetup() {
  // Clean previous test data
  if (existsSync(TEST_DATA)) {
    rmSync(TEST_DATA, { recursive: true });
  }

  // Create required directories
  mkdirSync(join(TEST_DATA, "nginx"), { recursive: true });
  mkdirSync(join(TEST_DATA, "data", "nginx", "conf.d"), { recursive: true });
  mkdirSync(join(TEST_DATA, "data", "nginx", "stream.d"), { recursive: true });
  mkdirSync(join(TEST_DATA, "data", "nginx", "auth"), { recursive: true });
  mkdirSync(join(TEST_DATA, "data", "logs"), { recursive: true });

  // Create minimal mime.types so nginx.conf include doesn't fail on read
  writeFileSync(join(TEST_DATA, "nginx", "mime.types"), "types {}\n");

  // Initialize test database
  execSync(`bun ${join(ROOT, "init-db.mjs")}`, {
    env: {
      ...process.env,
      DB_PATH: join(TEST_DATA, "db.sqlite"),
    },
    cwd: ROOT,
    stdio: "inherit",
  });
}
