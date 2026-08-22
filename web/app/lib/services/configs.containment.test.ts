import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// NO vi.mock("fs") here — this suite needs the real filesystem. It exists
// precisely because configs.test.ts mocks `fs` wholesale, including
// `realpathSync` (as `vi.fn((p: string) => p)`, an identity function), which
// makes the symlink-escape branch of resolveConfigPath structurally
// unreachable there: the containment check it defends against cannot occur
// under an identity realpath. `~/lib/db/connection` still has to be stubbed —
// it pulls in `bun:sqlite` transitively.
vi.mock("~/lib/db/connection", () => ({ db: {} }));

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nginx-contain-"));
  outside = mkdtempSync(join(tmpdir(), "nginx-outside-"));
  mkdirSync(join(root, "conf.d"), { recursive: true });
  writeFileSync(join(outside, "secret.conf"), "server { listen 1; }\n");
  // A symlink that lives inside the nginx dir but resolves outside it.
  symlinkSync(join(outside, "secret.conf"), join(root, "conf.d", "escape.conf"));
  process.env.NGINX_DIR = root;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveConfigPath containment (real fs)", () => {
  it("refuses a symlink that resolves outside the nginx dir", async () => {
    const { resolveConfigPath } = await import("./configs");
    const { InvalidPathError } = await import("./errors");
    expect(() => resolveConfigPath("conf.d/escape.conf")).toThrow(InvalidPathError);
  });

  it("accepts an ordinary file inside the nginx dir", async () => {
    const { resolveConfigPath } = await import("./configs");
    writeFileSync(join(root, "conf.d", "ok.conf"), "server { listen 2; }\n");
    expect(resolveConfigPath("conf.d/ok.conf")).toBe(join(root, "conf.d", "ok.conf"));
  });

  it("still refuses plain ../ traversal", async () => {
    const { resolveConfigPath } = await import("./configs");
    const { InvalidPathError } = await import("./errors");
    expect(() => resolveConfigPath("../../etc/passwd")).toThrow(InvalidPathError);
  });
});
