import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── In-memory store (declared before mocks so closures close over it) ───────

type HostRow = {
  id: number;
  groupId: number | null;
  domains: string[];
  enabled: boolean;
  sslType: string;
  sslForceHttps: boolean;
  sslCertPath: string | null;
  sslKeyPath: string | null;
  hsts: boolean;
  http2: boolean;
  compression: boolean;
  redirectWww: boolean;
  clientMaxBodySize: string;
  locations: unknown[];
  streamPorts: unknown[];
  webhookUrl: string | null;
  advancedNginx: string | null;
  basicAuth: unknown | null;
  draft: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

let _store: Map<number, HostRow>;
let _nextId: number;

function defaultRow(overrides: Partial<HostRow> & { id: number }): HostRow {
  return {
    groupId: null,
    domains: [],
    enabled: false,
    sslType: "none",
    sslForceHttps: false,
    sslCertPath: null,
    sslKeyPath: null,
    hsts: true,
    http2: true,
    compression: true,
    redirectWww: false,
    clientMaxBodySize: "1m",
    locations: [],
    streamPorts: [],
    webhookUrl: null,
    advancedNginx: null,
    basicAuth: null,
    draft: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Mock external dependencies ──────────────────────────────────────────────

vi.mock("~/lib/nginx/generator", () => ({
  generateAllConfigs: vi.fn(),
  removeHostConfig: vi.fn(),
}));
vi.mock("~/lib/nginx/validator", () => ({
  validateNginxConfig: vi.fn(() => ({ valid: true })),
}));
vi.mock("~/lib/nginx/reload", () => ({
  reloadNginx: vi.fn(),
}));
vi.mock("~/lib/audit/log", () => ({
  logAudit: vi.fn(),
}));

// ─── drizzle-orm eq — we just return the numeric value directly ───────────────
// The db mock will receive this as the "where condition" and we extract .val
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: any, val: any) => ({ __eq: true, val })),
}));

// ─── In-memory DB mock ────────────────────────────────────────────────────────
// Implements the fluent drizzle API surface used in hosts.ts.

vi.mock("~/lib/db/connection", () => {
  function idFrom(cond: any): number | undefined {
    if (cond && cond.__eq) return cond.val;
    return undefined;
  }

  const db = {
    select() {
      return {
        from(_table: any) {
          return {
            where(cond: any) {
              const id = idFrom(cond);
              return {
                get(): HostRow | undefined {
                  return id !== undefined ? _store.get(id) : undefined;
                },
              };
            },
            all(): HostRow[] {
              return Array.from(_store.values());
            },
          };
        },
      };
    },

    insert(_table: any) {
      return {
        values(v: any) {
          const id = v.id !== undefined ? v.id : _nextId++;
          const row = defaultRow({ ...v, id });
          _store.set(id, row);
          return {
            returning() {
              return { get: () => row };
            },
            run: () => undefined,
          };
        },
      };
    },

    update(_table: any) {
      return {
        set(patch: any) {
          return {
            where(cond: any) {
              const id = idFrom(cond);
              return {
                returning() {
                  return {
                    get(): HostRow | undefined {
                      if (id === undefined) return undefined;
                      const existing = _store.get(id);
                      if (!existing) return undefined;
                      const updated = { ...existing, ...patch };
                      _store.set(id, updated);
                      return updated;
                    },
                  };
                },
                run(): void {
                  if (id === undefined) return;
                  const existing = _store.get(id);
                  if (!existing) return;
                  _store.set(id, { ...existing, ...patch });
                },
              };
            },
          };
        },
      };
    },

    delete(_table: any) {
      return {
        where(cond: any) {
          const id = idFrom(cond);
          return {
            run(): void {
              if (id !== undefined) _store.delete(id);
            },
          };
        },
      };
    },
  };

  return { db };
});

// ─── Import service under test ────────────────────────────────────────────────

import { generateAllConfigs, removeHostConfig } from "~/lib/nginx/generator";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { reloadNginx } from "~/lib/nginx/reload";
import { logAudit } from "~/lib/audit/log";
import type { AuthContext } from "~/lib/auth/authenticate";
import type { Scope } from "~/lib/auth/scopes";
import { ForbiddenError, NotFoundError, HostValidationError } from "./errors";
import {
  listHosts,
  getHost,
  createHost,
  updateHost,
  discardHostDraft,
  publishHost,
  deleteHost,
} from "./hosts";

// ─── Auth context helpers ─────────────────────────────────────────────────────

const ctx = (scopes: Scope[]): AuthContext => ({
  userId: 1,
  role: "editor",
  via: "session",
  scopes,
});

const tokenCtx = (scopes: Scope[]): AuthContext => ({
  userId: 1,
  role: "editor",
  via: "token",
  tokenId: 42,
  scopes,
});

const viewerCtx = (): AuthContext => ({
  userId: 2,
  role: "viewer",
  via: "session",
  scopes: ["hosts:read", "stats:read"],
});

// ─── Minimal valid publish data (semantically valid for validatePublishData) ──

const validDraft = {
  domains: ["example.com"],
  locations: [
    {
      path: "/",
      matchType: "prefix",
      type: "proxy",
      upstreams: [{ server: "127.0.0.1", port: 8080, protocol: "http" }],
    },
  ],
  streamPorts: [] as any[],
  enabled: true,
  sslType: "none",
  sslForceHttps: false,
  hsts: true,
  http2: true,
  compression: true,
  redirectWww: false,
};

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  _store = new Map();
  _nextId = 1;
  vi.clearAllMocks();
  vi.mocked(validateNginxConfig).mockReturnValue({ valid: true });
});

// ─── Scope rejection ─────────────────────────────────────────────────────────

describe("scope rejection", () => {
  it("listHosts requires hosts:read", () => {
    expect(() => listHosts(ctx([]))).toThrow(ForbiddenError);
  });

  it("getHost — viewer (has hosts:read) gets NotFound, no-scope gets Forbidden", () => {
    expect(() => getHost(ctx([]), 99)).toThrow(ForbiddenError);
    // viewer has hosts:read but row missing → NotFoundError
    expect(() => getHost(viewerCtx(), 99)).toThrow(NotFoundError);
  });

  it("createHost requires hosts:write", async () => {
    await expect(createHost(viewerCtx(), {})).rejects.toThrow(ForbiddenError);
  });

  it("updateHost requires hosts:write", async () => {
    await expect(updateHost(viewerCtx(), 1, {})).rejects.toThrow(ForbiddenError);
  });

  it("discardHostDraft requires hosts:write", () => {
    expect(() => discardHostDraft(viewerCtx(), 1)).toThrow(ForbiddenError);
  });

  it("publishHost requires hosts:publish", async () => {
    await expect(publishHost(ctx(["hosts:write"]), 1)).rejects.toThrow(ForbiddenError);
  });

  it("deleteHost requires hosts:publish", async () => {
    await expect(deleteHost(ctx(["hosts:write"]), 1)).rejects.toThrow(ForbiddenError);
  });
});

// ─── createHost ──────────────────────────────────────────────────────────────

describe("createHost", () => {
  it("inserts with enabled:false and draft payload", async () => {
    const row = await createHost(ctx(["hosts:write"]), {
      domains: ["example.com"],
      locations: validDraft.locations,
      streamPorts: [],
    });
    expect(row.enabled).toBe(false);
    expect(row.draft).toBeTruthy();
    expect((row.draft as any).domains).toEqual(["example.com"]);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "create",
        entity: "host",
        details: expect.objectContaining({ draft: true }),
      })
    );
  });

  it("rejects unknown field", async () => {
    await expect(createHost(ctx(["hosts:write"]), { badField: 1 })).rejects.toThrow("Unknown field: badField");
  });

  it("rejects labelIds as unknown field", async () => {
    await expect(createHost(ctx(["hosts:write"]), { labelIds: [1, 2] })).rejects.toThrow("Unknown field: labelIds");
  });

  it("includes tokenId in audit when via token", async () => {
    await createHost(tokenCtx(["hosts:write"]), { domains: ["t.com"] });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ tokenId: 42, via: "token" }),
      })
    );
  });

  it("hashes basicAuth passwords (not stored in plaintext)", async () => {
    const row = await createHost(ctx(["hosts:write"]), {
      domains: ["sec.com"],
      basicAuth: {
        enabled: true,
        users: [{ username: "alice", password: "s3cr3t" }],
      },
    });
    const stored = (row.draft as any).basicAuth;
    expect(stored.users[0].password).toBeTruthy();
    expect(stored.users[0].password).not.toBe("s3cr3t");
    // bcrypt hashes start with $2
    expect(stored.users[0].password).toMatch(/^\$2/);
  });
});

// ─── updateHost ──────────────────────────────────────────────────────────────

describe("updateHost", () => {
  it("touches only draft column, not live fields", async () => {
    // createHost inserts minimal live row (domains from input, locations:[], streamPorts:[])
    // then updateHost stores patch only in draft — live locations stays []
    const row = await createHost(ctx(["hosts:write"]), {
      locations: [{ path: "/", matchType: "prefix", type: "proxy", upstreams: [] }],
    });
    const updated = await updateHost(ctx(["hosts:write"]), row.id, {
      domains: ["updated.com"],
    });
    // live locations unchanged (was set to [] on create)
    expect(updated.locations).toEqual([]);
    // draft has the update
    expect((updated.draft as any).domains).toEqual(["updated.com"]);
  });

  it("merges patch over draft when draft exists", async () => {
    const row = await createHost(ctx(["hosts:write"]), {
      domains: ["a.com"],
      locations: [],
    });
    const updated = await updateHost(ctx(["hosts:write"]), row.id, { domains: ["b.com"] });
    expect((updated.draft as any).domains).toEqual(["b.com"]);
  });

  it("throws NotFoundError for missing id", async () => {
    await expect(updateHost(ctx(["hosts:write"]), 9999, { domains: [] })).rejects.toThrow(NotFoundError);
  });

  it("rejects unknown field", async () => {
    const row = await createHost(ctx(["hosts:write"]), {});
    await expect(updateHost(ctx(["hosts:write"]), row.id, { evil: true })).rejects.toThrow("Unknown field: evil");
  });
});

// ─── discardHostDraft ─────────────────────────────────────────────────────────

describe("discardHostDraft", () => {
  it("clears draft column", async () => {
    const row = await createHost(ctx(["hosts:write"]), { domains: ["d.com"] });
    expect(row.draft).not.toBeNull();
    const result = discardHostDraft(ctx(["hosts:write"]), row.id);
    expect(result.draft).toBeNull();
  });

  it("is a no-op if draft already null", async () => {
    const row = await createHost(ctx(["hosts:write"]), {});
    discardHostDraft(ctx(["hosts:write"]), row.id);
    // discard again — should not throw
    const result = discardHostDraft(ctx(["hosts:write"]), row.id);
    expect(result.draft).toBeNull();
  });

  it("throws NotFoundError for missing row", () => {
    expect(() => discardHostDraft(ctx(["hosts:write"]), 9999)).toThrow(NotFoundError);
  });
});

// ─── publishHost happy path ───────────────────────────────────────────────────

describe("publishHost — happy path", () => {
  it("moves draft to live fields, clears draft, calls reload once", async () => {
    const row = await createHost(ctx(["hosts:write"]), { ...validDraft });

    const published = await publishHost(ctx(["hosts:publish"]), row.id);

    expect(published.draft).toBeNull();
    expect(published.domains).toEqual(["example.com"]);
    expect(published.enabled).toBe(true);
    expect(reloadNginx).toHaveBeenCalledTimes(1);
    expect(generateAllConfigs).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update",
        entity: "host",
        details: expect.objectContaining({ published: true }),
      })
    );
  });

  it("rejects with HostValidationError (input) when draft is semantically invalid", async () => {
    const row = await createHost(ctx(["hosts:write"]), {
      // locations but no domains
      domains: [],
      locations: [{ path: "/", matchType: "prefix", type: "proxy", upstreams: [{ server: "a", port: 80 }] }],
      streamPorts: [],
    });

    await expect(publishHost(ctx(["hosts:publish"]), row.id)).rejects.toMatchObject({
      name: "HostValidationError",
      kind: "input",
    });
    expect(reloadNginx).not.toHaveBeenCalled();
    expect(generateAllConfigs).not.toHaveBeenCalled();
  });
});

// ─── publishHost — nginx -t failure (row restored) ───────────────────────────

describe("publishHost — nginx -t failure", () => {
  it("restores row byte-identical (full deep-equal), calls generateAllConfigs twice, reload NOT called", async () => {
    const row = await createHost(ctx(["hosts:write"]), { ...validDraft });
    // Capture the full pre-publish snapshot
    const prePublishSnapshot = { ..._store.get(row.id)! };

    vi.mocked(validateNginxConfig).mockReturnValue({ valid: false, error: "bad syntax" });

    await expect(publishHost(ctx(["hosts:publish"]), row.id)).rejects.toMatchObject({
      name: "HostValidationError",
      kind: "nginx",
      message: "bad syntax",
    });

    expect(reloadNginx).not.toHaveBeenCalled();
    expect(generateAllConfigs).toHaveBeenCalledTimes(2); // write + restore

    // Full-row deep-equal: every column must match the pre-publish snapshot
    const restored = _store.get(row.id)!;
    expect(restored.domains).toEqual(prePublishSnapshot.domains);
    expect(restored.groupId).toBe(prePublishSnapshot.groupId);
    expect(restored.enabled).toBe(prePublishSnapshot.enabled);
    expect(restored.sslType).toBe(prePublishSnapshot.sslType);
    expect(restored.sslForceHttps).toBe(prePublishSnapshot.sslForceHttps);
    expect(restored.sslCertPath).toBe(prePublishSnapshot.sslCertPath);
    expect(restored.sslKeyPath).toBe(prePublishSnapshot.sslKeyPath);
    expect(restored.hsts).toBe(prePublishSnapshot.hsts);
    expect(restored.http2).toBe(prePublishSnapshot.http2);
    expect(restored.compression).toBe(prePublishSnapshot.compression);
    expect(restored.redirectWww).toBe(prePublishSnapshot.redirectWww);
    expect(restored.webhookUrl).toBe(prePublishSnapshot.webhookUrl);
    expect(restored.advancedNginx).toBe(prePublishSnapshot.advancedNginx);
    expect(restored.clientMaxBodySize).toBe(prePublishSnapshot.clientMaxBodySize);
    expect(JSON.stringify(restored.draft)).toBe(JSON.stringify(prePublishSnapshot.draft));
    expect(JSON.stringify(restored.locations)).toBe(JSON.stringify(prePublishSnapshot.locations));
    expect(JSON.stringify(restored.streamPorts)).toBe(JSON.stringify(prePublishSnapshot.streamPorts));
  });

  it("publish with groupId:null in draft clears groupId on live row", async () => {
    // Create a host that starts with a groupId set
    const row = await createHost(ctx(["hosts:write"]), { ...validDraft });
    // Manually set groupId on the live row to simulate a previously assigned group
    _store.set(row.id, { ..._store.get(row.id)!, groupId: 7 });

    // Update draft to include groupId: null (removing the group)
    await updateHost(ctx(["hosts:write"]), row.id, { ...validDraft, groupId: null as any });

    vi.mocked(validateNginxConfig).mockReturnValue({ valid: true });

    const published = await publishHost(ctx(["hosts:publish"]), row.id);

    expect(published.groupId).toBeNull();
  });

  it("restores and rethrows when validator itself throws (spawn failure)", async () => {
    const row = await createHost(ctx(["hosts:write"]), { ...validDraft });

    vi.mocked(validateNginxConfig).mockImplementation(() => {
      throw new Error("nginx binary missing");
    });

    await expect(publishHost(ctx(["hosts:publish"]), row.id)).rejects.toThrow("nginx binary missing");

    expect(reloadNginx).not.toHaveBeenCalled();
    expect(generateAllConfigs).toHaveBeenCalledTimes(2); // write + restore

    // Row still present
    expect(_store.has(row.id)).toBe(true);
  });
});

// ─── deleteHost ──────────────────────────────────────────────────────────────

describe("deleteHost — happy path", () => {
  it("removes row, calls removeHostConfig, reload", async () => {
    const row = await createHost(ctx(["hosts:write"]), { ...validDraft });
    const id = row.id;

    vi.clearAllMocks();
    vi.mocked(validateNginxConfig).mockReturnValue({ valid: true });

    await deleteHost(ctx(["hosts:publish"]), id);

    expect(_store.has(id)).toBe(false);
    expect(removeHostConfig).toHaveBeenCalledWith(id);
    expect(reloadNginx).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete", entity: "host", entityId: id })
    );
  });
});

describe("deleteHost — rollback re-inserts same id", () => {
  it("re-inserts the exact same row (same id) when nginx -t fails", async () => {
    const row = await createHost(ctx(["hosts:write"]), { ...validDraft });
    const id = row.id;

    vi.clearAllMocks();
    vi.mocked(validateNginxConfig).mockReturnValue({ valid: false, error: "stream error" });

    await expect(deleteHost(ctx(["hosts:publish"]), id)).rejects.toMatchObject({
      name: "HostValidationError",
      kind: "nginx",
    });

    // Row must still exist with the same id
    expect(_store.has(id)).toBe(true);
    expect(_store.get(id)!.id).toBe(id);
    expect(reloadNginx).not.toHaveBeenCalled();
    // delete runs generateAllConfigs, then restore also runs it = 2 total
    expect(generateAllConfigs).toHaveBeenCalledTimes(2); // delete-gen + restore-gen
  });

  it("re-inserts and rethrows when validator throws on delete", async () => {
    const row = await createHost(ctx(["hosts:write"]), { ...validDraft });
    const id = row.id;

    vi.clearAllMocks();
    vi.mocked(validateNginxConfig).mockImplementation(() => {
      throw new Error("spawn fail");
    });

    await expect(deleteHost(ctx(["hosts:publish"]), id)).rejects.toThrow("spawn fail");

    expect(_store.has(id)).toBe(true);
    expect(reloadNginx).not.toHaveBeenCalled();
  });
});

// ─── getHost / listHosts ─────────────────────────────────────────────────────

describe("getHost", () => {
  it("returns the host row", async () => {
    const created = await createHost(ctx(["hosts:write"]), { domains: ["g.com"] });
    const found = getHost(ctx(["hosts:read"]), created.id);
    expect(found.id).toBe(created.id);
  });

  it("throws NotFoundError for missing id", () => {
    expect(() => getHost(ctx(["hosts:read"]), 9999)).toThrow(NotFoundError);
  });
});

describe("listHosts", () => {
  it("returns all hosts", async () => {
    await createHost(ctx(["hosts:write"]), { domains: ["a.com"] });
    await createHost(ctx(["hosts:write"]), { domains: ["b.com"] });
    const all = listHosts(ctx(["hosts:read"]));
    expect(all.length).toBe(2);
  });
});

// ─── input validation edge cases ─────────────────────────────────────────────

describe("input validation", () => {
  it("rejects labelIds as unknown key", async () => {
    await expect(createHost(ctx(["hosts:write"]), { labelIds: [] })).rejects.toThrow("Unknown field: labelIds");
  });

  it("rejects any unknown key", async () => {
    await expect(createHost(ctx(["hosts:write"]), { hackerField: "x" })).rejects.toThrow("Unknown field: hackerField");
  });

  it("accepts all allowlisted keys without error", async () => {
    await expect(
      createHost(ctx(["hosts:write"]), {
        domains: ["ok.com"],
        enabled: false,
        sslType: "none",
        sslForceHttps: false,
        sslCertPath: "",
        sslKeyPath: "",
        hsts: true,
        http2: true,
        compression: true,
        redirectWww: false,
        locations: [],
        basicAuth: null,
        streamPorts: [],
        webhookUrl: "",
        advancedNginx: "",
        clientMaxBodySize: "1m",
      })
    ).resolves.toBeTruthy();
  });

  it("rejects invalid domain string", async () => {
    await expect(createHost(ctx(["hosts:write"]), { domains: ["not valid!"] })).rejects.toThrow("Invalid domain");
  });

  it("allows wildcard domain prefix", async () => {
    await expect(
      createHost(ctx(["hosts:write"]), { domains: ["*.example.com"] })
    ).resolves.toBeTruthy();
  });
});
