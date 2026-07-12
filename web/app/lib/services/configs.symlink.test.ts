/**
 * Symlink-hardening tests for resolveConfigPath.
 * fs is NOT mocked here — real filesystem operations (mkdtempSync, symlinkSync) are used.
 * Only the DB-touching transitive dependencies are mocked to allow import.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

// Mock DB-touching modules so the SQLite connection is never opened.
vi.mock("~/lib/config/versions", () => ({ saveVersion: vi.fn() }));
vi.mock("~/lib/audit/log", () => ({ logAudit: vi.fn() }));
vi.mock("~/lib/nginx/validator", () => ({ validateNginxConfig: vi.fn(() => ({ valid: true })) }));
vi.mock("~/lib/nginx/reload", () => ({ reloadNginx: vi.fn(() => true) }));

import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { InvalidPathError } from "./errors";
import { resolveConfigPath } from "./configs";

const created: string[] = [];
const originalNginxDir = process.env.NGINX_DIR;

function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "nginx-mgr-"));
  created.push(d);
  return d;
}

afterEach(() => {
  process.env.NGINX_DIR = originalNginxDir;
  while (created.length) {
    const d = created.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
});

describe("resolveConfigPath — symlink hardening", () => {
  it("rejects a symlinked .conf file inside nginx dir that points to a file outside", () => {
    const outside = makeTempDir();
    const nginxDir = makeTempDir();
    process.env.NGINX_DIR = nginxDir;

    // Create a real .conf file outside the nginx dir so the symlink target exists
    const realTarget = join(outside, "secret.conf");
    writeFileSync(realTarget, "secret content");

    // Place a symlink inside nginxDir pointing to the outside file
    const symlinkInNginx = join(nginxDir, "evil.conf");
    symlinkSync(realTarget, symlinkInNginx);

    expect(() => resolveConfigPath("evil.conf")).toThrow(InvalidPathError);
  });

  it("rejects a path through a symlinked subdirectory that resolves outside", () => {
    const outside = makeTempDir();
    const nginxDir = makeTempDir();
    process.env.NGINX_DIR = nginxDir;

    // Create symlink: nginxDir/subdir -> outside
    const symlinkDir = join(nginxDir, "subdir");
    symlinkSync(outside, symlinkDir);

    // Access through the symlinked subdir
    expect(() => resolveConfigPath("subdir/target.conf")).toThrow(InvalidPathError);
  });

  it("rejects a new draft path under a symlinked-out dir (file does not exist yet)", () => {
    const outside = makeTempDir();
    const nginxDir = makeTempDir();
    process.env.NGINX_DIR = nginxDir;

    // symlink: nginxDir/escape -> outside dir (the dir itself exists so ancestor walk reaches it)
    const symlinkDir = join(nginxDir, "escape");
    symlinkSync(outside, symlinkDir);

    // File does not exist yet (draft creation scenario — ancestor walk is exercised)
    expect(() => resolveConfigPath("escape/new.conf")).toThrow(InvalidPathError);
    expect(() =>
      resolveConfigPath("escape/new.conf.draft", { allowDraft: true })
    ).toThrow(InvalidPathError);
  });

  it("accepts a legit nested path sites/a.conf with no symlinks", () => {
    const nginxDir = makeTempDir();
    process.env.NGINX_DIR = nginxDir;

    const sitesDir = join(nginxDir, "sites");
    mkdirSync(sitesDir, { recursive: true });

    // File doesn't need to exist for resolveConfigPath (it only checks path containment)
    const result = resolveConfigPath("sites/a.conf");

    // Compare against realpath of nginxDir to handle /tmp -> /private/tmp etc.
    const realNginxDir = realpathSync(nginxDir);
    expect(result).toBe(join(realNginxDir, "sites", "a.conf"));
  });

  it("accepts a legit file when the nginx dir itself is a symlink", () => {
    const realDir = makeTempDir();
    const holderDir = makeTempDir();
    const symlinkNginxDir = join(holderDir, "nginx-link");
    symlinkSync(realDir, symlinkNginxDir);
    process.env.NGINX_DIR = symlinkNginxDir;

    // Should not throw — a file genuinely inside the nginx dir (even via symlink) is allowed.
    // The returned path is realpath-resolved so we compare against the real dir.
    let result: string;
    expect(() => {
      result = resolveConfigPath("site.conf");
    }).not.toThrow();

    // After implementation the returned path will be realpath-normalised.
    const realNginxDir = realpathSync(realDir);
    expect(result!).toBe(join(realNginxDir, "site.conf"));
  });
});
