import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  realpathSync: vi.fn((p: string) => p),
}));
vi.mock("~/lib/nginx/validator", () => ({ validateNginxConfig: vi.fn(() => ({ valid: true })) }));
vi.mock("~/lib/nginx/reload", () => ({ reloadNginx: vi.fn(() => true) }));
vi.mock("~/lib/config/versions", () => ({ saveVersion: vi.fn() }));
vi.mock("~/lib/audit/log", () => ({ logAudit: vi.fn() }));

import { writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { reloadNginx } from "~/lib/nginx/reload";
import { applyClusterConfigs } from "./cluster-receive";

describe("applyClusterConfigs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NGINX_DIR = "/data/nginx";
    vi.mocked(validateNginxConfig).mockReturnValue({ valid: true });
    vi.mocked(reloadNginx).mockReturnValue(true);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("writes legitimate config files from a normal sync payload", () => {
    const result = applyClusterConfigs({
      "/data/nginx/conf.d/host-1.conf": "server {}",
      "/data/nginx/nginx.conf": "events {}",
    });

    expect(result.written).toBe(2);
    expect(result.rejected).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.reloaded).toBe(true);
    expect(writeFileSync).toHaveBeenCalledWith("/data/nginx/conf.d/host-1.conf", "server {}");
  });

  it("rejects an absolute path outside the nginx dir and writes nothing at all", () => {
    const result = applyClusterConfigs({
      "/data/nginx/conf.d/host-1.conf": "server {}",
      "/etc/passwd": "root::0:0::/root:/bin/sh",
    });

    expect(result.rejected).toEqual(["/etc/passwd"]);
    expect(result.written).toBe(0);
    expect(result.valid).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(reloadNginx).not.toHaveBeenCalled();
  });

  it("rejects a ../ traversal escape", () => {
    const result = applyClusterConfigs({
      "/data/nginx/conf.d/../../../root/.ssh/authorized_keys": "ssh-rsa AAAA",
    });

    expect(result.rejected).toHaveLength(1);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects a non-.conf file inside the nginx dir", () => {
    const result = applyClusterConfigs({ "/data/nginx/evil.sh": "rm -rf /" });

    expect(result.rejected).toEqual(["/data/nginx/evil.sh"]);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("restores every touched file when nginx -t fails", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("previous" as never);
    vi.mocked(validateNginxConfig).mockReturnValue({ valid: false, error: "bad directive" });

    const result = applyClusterConfigs({ "/data/nginx/conf.d/host-1.conf": "broken" });

    expect(result.valid).toBe(false);
    expect(result.validationError).toBe("bad directive");
    expect(result.written).toBe(0);
    const writes = vi.mocked(writeFileSync).mock.calls;
    expect(writes[writes.length - 1]).toEqual(["/data/nginx/conf.d/host-1.conf", "previous"]);
    expect(reloadNginx).not.toHaveBeenCalled();
  });

  it("deletes files that did not exist before when nginx -t fails", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(validateNginxConfig).mockReturnValue({ valid: false, error: "bad" });

    applyClusterConfigs({ "/data/nginx/conf.d/new.conf": "broken" });

    expect(unlinkSync).toHaveBeenCalledWith("/data/nginx/conf.d/new.conf");
  });

  it("reports reloaded:false when the reload fails", () => {
    vi.mocked(reloadNginx).mockReturnValue(false);
    const result = applyClusterConfigs({ "/data/nginx/conf.d/host-1.conf": "server {}" });
    expect(result.reloaded).toBe(false);
    expect(result.valid).toBe(true);
  });
});
