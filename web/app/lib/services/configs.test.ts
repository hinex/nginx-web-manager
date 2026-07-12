import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));
vi.mock("~/lib/config/versions", () => ({ saveVersion: vi.fn() }));
vi.mock("~/lib/nginx/validator", () => ({ validateNginxConfig: vi.fn(() => ({ valid: true })) }));
vi.mock("~/lib/nginx/reload", () => ({ reloadNginx: vi.fn(() => true) }));
vi.mock("~/lib/audit/log", () => ({ logAudit: vi.fn() }));

import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "fs";
import { saveVersion } from "~/lib/config/versions";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { reloadNginx } from "~/lib/nginx/reload";
import { logAudit } from "~/lib/audit/log";
import type { AuthContext } from "~/lib/auth/authenticate";
import type { Scope } from "~/lib/auth/scopes";
import { ForbiddenError, InvalidPathError, NotFoundError } from "./errors";
import {
  resolveConfigPath,
  readConfig,
  writeConfigDraft,
  publishConfig,
  deleteConfig,
  listConfigs,
} from "./configs";

const ctx = (scopes: Scope[]): AuthContext => ({
  userId: 1,
  role: "editor",
  via: "token",
  tokenId: 7,
  scopes,
});

const LIVE = "/data/nginx/conf.d/site.conf";
const DRAFT = LIVE + ".draft";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NGINX_DIR = "/data/nginx";
  vi.mocked(validateNginxConfig).mockReturnValue({ valid: true });
  vi.mocked(existsSync).mockReturnValue(false);
});

describe("resolveConfigPath", () => {
  it("accepts relative path inside nginx dir", () => {
    expect(resolveConfigPath("conf.d/site.conf")).toBe(LIVE);
  });

  it("accepts absolute path inside nginx dir", () => {
    expect(resolveConfigPath(LIVE)).toBe(LIVE);
  });

  it("rejects traversal outside nginx dir", () => {
    expect(() => resolveConfigPath("../../etc/passwd.conf")).toThrow(InvalidPathError);
    expect(() => resolveConfigPath("/etc/nginx/nginx.conf")).toThrow(InvalidPathError);
  });

  it("rejects non-.conf files", () => {
    expect(() => resolveConfigPath("conf.d/site.txt")).toThrow(InvalidPathError);
  });

  it("rejects .draft unless allowed", () => {
    expect(() => resolveConfigPath("conf.d/site.conf.draft")).toThrow(InvalidPathError);
    expect(resolveConfigPath("conf.d/site.conf.draft", { allowDraft: true })).toBe(DRAFT);
  });
});

describe("readConfig", () => {
  it("requires configs:read", () => {
    expect(() => readConfig(ctx([]), LIVE)).toThrow(ForbiddenError);
    expect(() => readConfig(ctx([]), LIVE)).toThrow("token lacks scope configs:read");
  });

  it("throws NotFoundError for missing file", () => {
    expect(() => readConfig(ctx(["configs:read"]), LIVE)).toThrow(NotFoundError);
  });

  it("reads existing file", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("server {}" as any);
    expect(readConfig(ctx(["configs:read"]), LIVE)).toBe("server {}");
  });
});

describe("writeConfigDraft", () => {
  it("requires configs:write", () => {
    expect(() => writeConfigDraft(ctx(["configs:read"]), LIVE, "x")).toThrow(
      "token lacks scope configs:write"
    );
  });

  it("writes draft, validates via temporary swap, restores live", () => {
    vi.mocked(existsSync).mockImplementation((p) => p === LIVE);
    vi.mocked(readFileSync).mockReturnValue("old content" as any);
    const result = writeConfigDraft(ctx(["configs:write"]), LIVE, "new content");
    expect(result).toEqual({ draftPath: DRAFT, valid: true, error: undefined });
    expect(saveVersion).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: LIVE, content: "old content", userId: 1 })
    );
    const writes = vi.mocked(writeFileSync).mock.calls.map((c) => [c[0], c[1]]);
    expect(writes).toEqual([
      [DRAFT, "new content"],
      [LIVE, "new content"], // temporary swap for nginx -t
      [LIVE, "old content"], // restored
    ]);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "config_draft",
        details: expect.objectContaining({ tokenId: 7, via: "token" }),
      })
    );
  });

  it("keeps draft and reports error when nginx -t fails", () => {
    vi.mocked(existsSync).mockImplementation((p) => p === LIVE);
    vi.mocked(readFileSync).mockReturnValue("old" as any);
    vi.mocked(validateNginxConfig).mockReturnValue({ valid: false, error: "boom" });
    const result = writeConfigDraft(ctx(["configs:write"]), LIVE, "bad");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("boom");
    expect(unlinkSync).not.toHaveBeenCalledWith(DRAFT);
    // live restored even on failure
    expect(vi.mocked(writeFileSync).mock.calls.at(-1)).toEqual([LIVE, "old"]);
  });

  it("removes temporary live file for brand-new configs", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    writeConfigDraft(ctx(["configs:write"]), LIVE, "fresh");
    expect(unlinkSync).toHaveBeenCalledWith(LIVE);
    expect(saveVersion).not.toHaveBeenCalled();
  });
});

describe("publishConfig", () => {
  it("requires configs:publish", () => {
    expect(() => publishConfig(ctx(["configs:write"]), LIVE)).toThrow(
      "token lacks scope configs:publish"
    );
  });

  it("throws NotFoundError when no draft exists", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => publishConfig(ctx(["configs:publish"]), LIVE)).toThrow(NotFoundError);
  });

  it("publishes valid draft: snapshot, write live, delete draft, reload", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((p) =>
      (p === DRAFT ? "draft content" : "live content") as any
    );
    const result = publishConfig(ctx(["configs:publish"]), LIVE);
    expect(result).toEqual({ published: true, valid: true });
    expect(saveVersion).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: LIVE, content: "live content" })
    );
    expect(writeFileSync).toHaveBeenCalledWith(LIVE, "draft content");
    expect(unlinkSync).toHaveBeenCalledWith(DRAFT);
    expect(reloadNginx).toHaveBeenCalled();
  });

  it("rolls back live and keeps draft when validation fails", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((p) =>
      (p === DRAFT ? "bad draft" : "live content") as any
    );
    vi.mocked(validateNginxConfig).mockReturnValue({ valid: false, error: "syntax" });
    const result = publishConfig(ctx(["configs:publish"]), LIVE);
    expect(result).toEqual({ published: false, valid: false, error: "syntax" });
    expect(vi.mocked(writeFileSync).mock.calls.at(-1)).toEqual([LIVE, "live content"]);
    expect(unlinkSync).not.toHaveBeenCalled();
    expect(reloadNginx).not.toHaveBeenCalled();
  });

  it("restores live content when the validator itself throws", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((p) =>
      (p === DRAFT ? "draft content" : "live content") as any
    );
    vi.mocked(validateNginxConfig).mockImplementation(() => {
      throw new Error("nginx binary missing");
    });
    expect(() => publishConfig(ctx(["configs:publish"]), LIVE)).toThrow(
      "nginx binary missing"
    );
    expect(vi.mocked(writeFileSync).mock.calls.at(-1)).toEqual([LIVE, "live content"]);
    expect(unlinkSync).not.toHaveBeenCalled();
    expect(reloadNginx).not.toHaveBeenCalled();
  });
});

describe("listConfigs", () => {
  const entry = (name: string, dir = false) =>
    ({ name, isDirectory: () => dir }) as any;

  it("requires configs:read", () => {
    expect(() => listConfigs(ctx([]))).toThrow(ForbiddenError);
  });

  it("splits .conf files and drafts, recursing into directories", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync)
      .mockReturnValueOnce([
        entry("site.conf"),
        entry("pending.conf.draft"),
        entry("nested", true),
        entry("readme.md"),
      ])
      .mockReturnValueOnce([entry("inner.conf")]);
    const result = listConfigs(ctx(["configs:read"]));
    expect(result.files.some((f) => f.endsWith("site.conf"))).toBe(true);
    expect(result.files.some((f) => f.endsWith("inner.conf"))).toBe(true);
    expect(result.drafts.some((f) => f.endsWith("pending.conf.draft"))).toBe(true);
    expect(result.files.some((f) => f.endsWith("readme.md"))).toBe(false);
  });

  it("returns empty lists when nginx dir is absent", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(listConfigs(ctx(["configs:read"]))).toEqual({ files: [], drafts: [] });
  });
});

describe("deleteConfig", () => {
  it("requires configs:publish", () => {
    expect(() => deleteConfig(ctx(["configs:write"]), LIVE)).toThrow(ForbiddenError);
  });

  it("snapshots a version before deleting", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("content" as any);
    expect(deleteConfig(ctx(["configs:publish"]), LIVE)).toEqual({ deleted: true });
    expect(saveVersion).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: LIVE, content: "content" })
    );
    expect(unlinkSync).toHaveBeenCalledWith(LIVE);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "delete" }));
  });
});
