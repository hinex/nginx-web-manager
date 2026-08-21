import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  // Identity: in tests, paths are already "real" — no symlinks to resolve.
  realpathSync: vi.fn((p: string) => p),
}));
vi.mock("~/lib/config/versions", () => ({ saveVersion: vi.fn() }));
vi.mock("~/lib/nginx/validator", () => ({ validateNginxConfig: vi.fn(() => ({ valid: true })) }));
vi.mock("~/lib/nginx/reload", () => ({ reloadNginx: vi.fn(() => true) }));
vi.mock("~/lib/audit/log", () => ({ logAudit: vi.fn() }));

// ── Reverse-sync fixtures & DB mock ──
//
// `configs.ts` imports `~/lib/db/connection` (a real bun:sqlite Database at
// module load time) and `~/lib/nginx/generator` (mapHostToConfig/loadAccessLists,
// which themselves touch the DB). Both must be mocked here. `mapHostToConfig`
// is stubbed with `rowToHostConfig` below rather than re-tested — that mapping
// is generator.ts's own responsibility (generator.test.ts covers it); this
// suite is about configs.ts's orchestration.
const { hostsStore, settingsStore, rowToHostConfig } = vi.hoisted(() => {
  const hostsStore = new Map<number, any>();
  const settingsStore = new Map<string, string>();
  function rowToHostConfig(row: any, dnsResolver = "", dnsResolverValid = "30s") {
    return {
      id: row.id,
      groupId: row.groupId ?? null,
      domains: row.domains ?? [],
      enabled: row.enabled ?? true,
      sslType: row.sslType ?? "none",
      sslForceHttps: row.sslForceHttps ?? false,
      sslCertPath: row.sslCertPath ?? null,
      sslKeyPath: row.sslKeyPath ?? null,
      hsts: row.hsts ?? true,
      http2: row.http2 ?? true,
      compression: row.compression ?? true,
      redirectWww: row.redirectWww ?? false,
      clientMaxBodySize: row.clientMaxBodySize ?? "1m",
      locations: (row.locations ?? []).map((loc: any) => ({ ...loc })),
      advancedNginx: row.advancedNginx ?? null,
      webhookUrl: row.webhookUrl ?? null,
      errorPagesDir: null,
      basicAuth: row.basicAuth ?? null,
      dnsResolver: dnsResolver || null,
      dnsResolverValid: dnsResolverValid || null,
      customPrelude: row.customPrelude ?? null,
    };
  }
  return { hostsStore, settingsStore, rowToHostConfig };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: any, val: any) => ({ __eq: true, val })),
}));

vi.mock("~/lib/nginx/generator", () => ({
  mapHostToConfig: vi.fn((row: any, dnsResolver: string, dnsResolverValid: string) =>
    rowToHostConfig(row, dnsResolver, dnsResolverValid)
  ),
  loadAccessLists: vi.fn(() => new Map()),
}));

vi.mock("~/lib/db/connection", () => {
  function makeQueryable() {
    return {
      select() {
        return {
          from() {
            return {
              where(cond: any) {
                return {
                  get() {
                    if (typeof cond.val === "number") {
                      const row = hostsStore.get(cond.val);
                      return row ? { ...row } : undefined;
                    }
                    if (typeof cond.val === "string") {
                      const v = settingsStore.get(cond.val);
                      return v !== undefined ? { key: cond.val, value: v } : undefined;
                    }
                    return undefined;
                  },
                };
              },
            };
          },
        };
      },
      update() {
        return {
          set(patch: any) {
            return {
              where(cond: any) {
                return {
                  run() {
                    const existing = hostsStore.get(cond.val);
                    if (existing) hostsStore.set(cond.val, { ...existing, ...patch });
                  },
                };
              },
            };
          },
        };
      },
    };
  }

  function transaction(cb: (tx: any) => void) {
    const snapshot = new Map([...hostsStore.entries()].map(([k, v]: [number, any]) => [k, { ...v }]));
    try {
      cb(makeQueryable());
    } catch (err) {
      hostsStore.clear();
      for (const [k, v] of snapshot) hostsStore.set(k, v);
      throw err;
    }
  }

  return { db: { ...makeQueryable(), transaction } };
});

import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, realpathSync } from "fs";
import { saveVersion } from "~/lib/config/versions";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { reloadNginx } from "~/lib/nginx/reload";
import { logAudit } from "~/lib/audit/log";
import type { AuthContext } from "~/lib/auth/authenticate";
import type { Scope } from "~/lib/auth/scopes";
import { ForbiddenError, InvalidPathError, NotFoundError, ConfigClassificationError } from "./errors";
import { buildServerBlock } from "~/lib/nginx/templates/server-block";
import {
  resolveConfigPath,
  readConfig,
  writeConfigDraft,
  writeConfigLive,
  publishConfig,
  deleteConfig,
  listConfigs,
  previewConfigEdit,
  applyConfigEdit,
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

describe("writeConfigLive", () => {
  const auth = ctx(["configs:read", "configs:write", "configs:publish"]);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateNginxConfig).mockReturnValue({ valid: true });
    vi.mocked(reloadNginx).mockReturnValue(true);
  });

  it("reverts the file and reports valid:false when nginx -t fails", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("original content" as never);
    vi.mocked(validateNginxConfig).mockReturnValue({ valid: false, error: "line 3: unknown directive" });

    const result = writeConfigLive(auth, "/data/nginx/conf.d/host-7.conf", "broken content");

    expect(result).toEqual({
      saved: false,
      valid: false,
      reloaded: false,
      error: "line 3: unknown directive",
    });
    // last write must restore the original
    const writes = vi.mocked(writeFileSync).mock.calls;
    expect(writes[writes.length - 1]).toEqual(["/data/nginx/conf.d/host-7.conf", "original content"]);
    expect(reloadNginx).not.toHaveBeenCalled();
  });

  it("deletes a newly created file when nginx -t fails", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(validateNginxConfig).mockReturnValue({ valid: false, error: "bad" });

    const result = writeConfigLive(auth, "/data/nginx/conf.d/new.conf", "broken");

    expect(result.saved).toBe(false);
    expect(unlinkSync).toHaveBeenCalledWith("/data/nginx/conf.d/new.conf");
  });

  it("reports reloaded:false when the reload command fails", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("old" as never);
    vi.mocked(reloadNginx).mockReturnValue(false);

    const result = writeConfigLive(auth, "/data/nginx/conf.d/host-7.conf", "good content");

    expect(result).toEqual({ saved: true, valid: true, reloaded: false });
  });

  it("saves a version of the previous content before overwriting", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("old" as never);

    writeConfigLive(auth, "/data/nginx/conf.d/host-7.conf", "new", "my message");

    expect(saveVersion).toHaveBeenCalledWith({
      filePath: "/data/nginx/conf.d/host-7.conf",
      content: "old",
      changeType: "manual_edit",
      userId: 1,
      message: "my message",
    });
  });

  it("rejects a path outside the nginx dir", () => {
    expect(() => writeConfigLive(auth, "/etc/passwd", "x")).toThrow(InvalidPathError);
  });

  it("rejects an auth context without configs:publish", () => {
    const viewer = { via: "session", userId: 2, scopes: ["configs:read"] } as AuthContext;
    expect(() => writeConfigLive(viewer, "/data/nginx/conf.d/host-7.conf", "x")).toThrow(ForbiddenError);
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

describe("previewConfigEdit / applyConfigEdit", () => {
  const auth = ctx(["configs:read", "configs:write", "configs:publish", "hosts:publish"]);

  function makeHostRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 1,
      groupId: null,
      domains: ["example.com"],
      enabled: true,
      sslType: "none",
      sslForceHttps: false,
      sslCertPath: null,
      sslKeyPath: null,
      hsts: true,
      http2: true,
      compression: true,
      redirectWww: false,
      clientMaxBodySize: "5m",
      locations: [
        {
          path: "/",
          matchType: "prefix",
          type: "proxy",
          upstreams: [{ server: "10.0.0.1", port: 8080, weight: 1 }],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "http",
          forwardDomain: "",
          forwardPath: "/",
          preservePath: true,
          statusCode: 301,
          headers: {},
          accessListId: null,
          basicAuth: null,
        },
      ],
      advancedNginx: null,
      webhookUrl: null,
      customPrelude: null,
      basicAuth: null,
      draft: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function baselineText(row: any) {
    return buildServerBlock(rowToHostConfig(row), new Map());
  }

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NGINX_DIR = "/data/nginx";
    hostsStore.clear();
    settingsStore.clear();
    vi.mocked(validateNginxConfig).mockReturnValue({ valid: true });
    vi.mocked(reloadNginx).mockReturnValue(true);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("falls through to a plain live write for a non-host-N.conf path", () => {
    const result = applyConfigEdit(auth, "conf.d/site.conf", "server { listen 80; }");
    expect(result.applied).toEqual([]);
    expect(result.saved).toBe(true);
    expect(writeFileSync).toHaveBeenCalledWith("/data/nginx/conf.d/site.conf", "server { listen 80; }");
  });

  it("throws ConfigClassificationError mentioning the draft when the host has one", () => {
    hostsStore.set(1, makeHostRow({ draft: { some: "change" } }));
    expect(() => applyConfigEdit(auth, "conf.d/host-1.conf", "server {}")).toThrow(ConfigClassificationError);
    try {
      applyConfigEdit(auth, "conf.d/host-1.conf", "server {}");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigClassificationError);
      expect((err as ConfigClassificationError).refusals[0].reason).toMatch(/draft/i);
    }
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("throws ConfigClassificationError with a line number for unparseable content", () => {
    hostsStore.set(1, makeHostRow());
    let caught: ConfigClassificationError | undefined;
    try {
      applyConfigEdit(auth, "conf.d/host-1.conf", "server {\n  listen 80;\n");
    } catch (err) {
      caught = err as ConfigClassificationError;
    }
    expect(caught).toBeInstanceOf(ConfigClassificationError);
    expect(caught!.refusals).toHaveLength(1);
    expect(caught!.refusals[0].line).toBe(1);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("throws and writes nothing for a refusal (letsencrypt cert path changed)", () => {
    const row = makeHostRow({ sslType: "letsencrypt" });
    hostsStore.set(1, row);
    const baseline = baselineText(row);
    const actual = baseline.replace(
      "/etc/letsencrypt/live/example.com/fullchain.pem",
      "/etc/ssl/custom/fullchain.pem"
    );
    expect(actual).not.toBe(baseline);

    let caught: ConfigClassificationError | undefined;
    try {
      applyConfigEdit(auth, "conf.d/host-1.conf", actual);
    } catch (err) {
      caught = err as ConfigClassificationError;
    }
    expect(caught).toBeInstanceOf(ConfigClassificationError);
    expect(caught!.refusals.length).toBeGreaterThan(0);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(hostsStore.get(1)).toEqual(row);
  });

  it("updates the DB and writes the regenerated (canonical) file for a clean edit", () => {
    const row = makeHostRow({ clientMaxBodySize: "5m" });
    hostsStore.set(1, row);
    const baseline = baselineText(row);
    // Cosmetic whitespace difference (extra space) on an unrelated line, plus
    // the real value change — proves the write is regenerated, not the raw
    // user text, since diffAst treats "listen  80;"/"listen 80;" identically.
    const actual = baseline
      .replace("client_max_body_size 5m;", "client_max_body_size 50m;")
      .replace("listen 80;", "listen  80;");

    const result = applyConfigEdit(auth, "conf.d/host-1.conf", actual);

    expect(result.saved).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ kind: "field", field: "clientMaxBodySize", to: "50m" });
    expect(hostsStore.get(1).clientMaxBodySize).toBe("50m");

    const writes = vi.mocked(writeFileSync).mock.calls;
    const finalWrite = writes[writes.length - 1];
    expect(finalWrite[0]).toBe("/data/nginx/conf.d/host-1.conf");
    expect(finalWrite[1]).toContain("client_max_body_size 50m;");
    expect(finalWrite[1]).not.toBe(actual);
  });

  it("rolls back the DB and restores the file when the regenerated config fails nginx -t", () => {
    const row = makeHostRow({ clientMaxBodySize: "5m" });
    hostsStore.set(1, row);
    const baseline = baselineText(row);
    const actual = baseline.replace("client_max_body_size 5m;", "client_max_body_size 50m;");

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(baseline as never);
    vi.mocked(validateNginxConfig).mockReturnValue({ valid: false, error: "unknown directive" });

    expect(() => applyConfigEdit(auth, "conf.d/host-1.conf", actual)).toThrow(ConfigClassificationError);

    // DB rolled back
    expect(hostsStore.get(1).clientMaxBodySize).toBe("5m");
    // file restored to the original as the last write
    const writes = vi.mocked(writeFileSync).mock.calls;
    expect(writes[writes.length - 1]).toEqual(["/data/nginx/conf.d/host-1.conf", baseline]);
    expect(reloadNginx).not.toHaveBeenCalled();
  });

  it("logs one audit row per edit, each carrying source config-editor", () => {
    const row = makeHostRow({ clientMaxBodySize: "5m" });
    hostsStore.set(1, row);
    const baseline = baselineText(row);
    const actual = baseline.replace("client_max_body_size 5m;", "client_max_body_size 50m;");

    applyConfigEdit(auth, "conf.d/host-1.conf", actual);

    const hostAuditCalls = vi.mocked(logAudit).mock.calls.filter(([args]) => args.entity === "host");
    expect(hostAuditCalls).toHaveLength(1);
    expect(hostAuditCalls[0][0]).toMatchObject({
      action: "update",
      entity: "host",
      entityId: 1,
      details: expect.objectContaining({ source: "config-editor" }),
    });
  });

  it("requires hosts:publish", () => {
    hostsStore.set(1, makeHostRow());
    const viewer = { via: "session", userId: 2, scopes: ["configs:read"] } as AuthContext;
    expect(() => applyConfigEdit(viewer, "conf.d/host-1.conf", "server {}")).toThrow(ForbiddenError);
  });

  it("previewConfigEdit classifies without writing or mutating the DB", () => {
    const row = makeHostRow({ clientMaxBodySize: "5m" });
    hostsStore.set(1, row);
    const baseline = baselineText(row);
    const actual = baseline.replace("client_max_body_size 5m;", "client_max_body_size 50m;");

    const preview = previewConfigEdit(auth, "conf.d/host-1.conf", actual);

    expect(preview.hostId).toBe(1);
    expect(preview.edits).toHaveLength(1);
    expect(preview.refusals).toEqual([]);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(hostsStore.get(1)).toEqual(row);
  });

  it("previewConfigEdit requires configs:read", () => {
    hostsStore.set(1, makeHostRow());
    expect(() => previewConfigEdit(ctx([]), "conf.d/host-1.conf", "server {}")).toThrow(ForbiddenError);
  });
});
