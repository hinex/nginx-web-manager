import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./middleware", () => ({
  checkIpWhitelist: vi.fn(async () => undefined),
  getClientIp: vi.fn(() => "10.0.0.1"),
}));
vi.mock("./rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  recordFailedAttempt: vi.fn(),
}));
vi.mock("./tokens", () => ({
  verifyApiToken: vi.fn(),
}));
vi.mock("./session.server", () => ({
  getSessionUser: vi.fn(async () => null),
}));

// db mock: supports sequential get() responses via a call-count queue
let dbGetResponses: Array<unknown> = [];
let dbGetCallCount = 0;

vi.mock("~/lib/db/connection", () => {
  const chain: Record<string, any> = {};
  for (const m of ["select", "from", "where"]) chain[m] = vi.fn(() => chain);
  chain.get = vi.fn(() => {
    const resp = dbGetResponses[dbGetCallCount];
    dbGetCallCount++;
    return resp;
  });
  return { db: chain };
});
vi.mock("~/lib/db/schema", () => ({
  users: { id: "id" },
  apiTokens: { id: "id", userId: "user_id" },
}));

import { db } from "~/lib/db/connection";
import { verifyApiToken } from "./tokens";
import { checkRateLimit, recordFailedAttempt } from "./rate-limit";
import { getSessionUser } from "./session.server";
import { authenticate } from "./authenticate";

const mockDb = db as any;

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/mcp", { headers });
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  try {
    await promise;
    throw new Error("expected authenticate to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(Response);
    expect((err as Response).status).toBe(status);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  vi.mocked(getSessionUser).mockResolvedValue(null);
  dbGetCallCount = 0;
  dbGetResponses = [];
});

// ── opaque ngm_ token tests ────────────────────────────────────────────────

describe("authenticate — bearer path (opaque ngm_ tokens)", () => {
  it("returns token context with scopes intersected against current role", async () => {
    vi.mocked(verifyApiToken).mockReturnValue({
      ok: true,
      tokenId: 7,
      userId: 3,
      scopes: ["configs:read", "configs:write"],
    });
    // opaque path: single db.get() for users
    dbGetResponses = [{ id: 3, role: "viewer" }];
    const ctx = await authenticate(req({ Authorization: "Bearer ngm_abc" }));
    expect(ctx).toEqual({
      userId: 3,
      role: "viewer",
      via: "token",
      tokenId: 7,
      scopes: ["configs:read"], // configs:write dropped: role was downgraded
    });
  });

  it("401 + failed attempt on invalid token", async () => {
    vi.mocked(verifyApiToken).mockReturnValue({ ok: false, reason: "revoked" });
    await expectStatus(authenticate(req({ Authorization: "Bearer ngm_bad" })), 401);
    expect(recordFailedAttempt).toHaveBeenCalledWith("10.0.0.1");
  });

  it("401 when token user no longer exists", async () => {
    vi.mocked(verifyApiToken).mockReturnValue({ ok: true, tokenId: 7, userId: 3, scopes: [] });
    dbGetResponses = [undefined]; // user not found
    await expectStatus(authenticate(req({ Authorization: "Bearer ngm_abc" })), 401);
  });

  it("429 when rate limited", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: false, retryAfterMs: 60000 });
    await expectStatus(authenticate(req({ Authorization: "Bearer ngm_abc" })), 429);
    expect(verifyApiToken).not.toHaveBeenCalled();
  });
});

// ── JWT OAuth bearer tests ─────────────────────────────────────────────────

describe("authenticate — JWT OAuth bearer path", () => {
  const mockTokenRow = {
    id: 42,
    userId: 7,
    name: "tok",
    tokenHash: "x",
    scopes: ["configs:read", "stats:read"],
    expiresAt: null as Date | null,
    revokedAt: null as Date | null,
    lastUsedAt: null,
    createdAt: new Date(),
  };
  const mockUser = { id: 7, email: "u@t.com", role: "editor" };

  async function issueJwt(scopes = ["configs:read", "stats:read"]): Promise<string> {
    const { createOAuthToken } = await import("./jwt.server");
    return createOAuthToken({ userId: 7, tokenId: 42, scopes });
  }

  it("accepts a valid OAuth JWT and returns correct AuthContext", async () => {
    const token = await issueJwt();
    dbGetResponses = [{ ...mockTokenRow }, { ...mockUser }];
    dbGetCallCount = 0;
    const ctx = await authenticate(req({ Authorization: `Bearer ${token}` }));
    expect(ctx.via).toBe("token");
    expect(ctx.userId).toBe(7);
    expect(ctx.tokenId).toBe(42);
    expect(ctx.scopes).toContain("configs:read");
    expect(ctx.scopes).toContain("stats:read");
  });

  it("rejects JWT when backing token row is revoked (liveness)", async () => {
    const token = await issueJwt();
    dbGetResponses = [{ ...mockTokenRow, revokedAt: new Date() }];
    dbGetCallCount = 0;
    await expectStatus(authenticate(req({ Authorization: `Bearer ${token}` })), 401);
    expect(recordFailedAttempt).toHaveBeenCalled();
  });

  it("rejects JWT when backing token row is expired (liveness)", async () => {
    const token = await issueJwt();
    dbGetResponses = [{ ...mockTokenRow, expiresAt: new Date(Date.now() - 1000) }];
    dbGetCallCount = 0;
    await expectStatus(authenticate(req({ Authorization: `Bearer ${token}` })), 401);
    expect(recordFailedAttempt).toHaveBeenCalled();
  });

  it("rejects JWT when backing token row is missing (liveness)", async () => {
    const token = await issueJwt();
    dbGetResponses = [undefined]; // no row found
    dbGetCallCount = 0;
    await expectStatus(authenticate(req({ Authorization: `Bearer ${token}` })), 401);
    expect(recordFailedAttempt).toHaveBeenCalled();
  });

  it("rejects JWT when user no longer exists", async () => {
    const token = await issueJwt();
    dbGetResponses = [{ ...mockTokenRow }, undefined]; // row ok, user gone
    dbGetCallCount = 0;
    await expectStatus(authenticate(req({ Authorization: `Bearer ${token}` })), 401);
    expect(recordFailedAttempt).toHaveBeenCalled();
  });

  it("rejects session JWT (no typ=oauth)", async () => {
    const { createToken } = await import("./jwt.server");
    const sessionJwt = await createToken({ userId: 7, email: "u@t.com", role: "editor" });
    dbGetResponses = [];
    await expectStatus(authenticate(req({ Authorization: `Bearer ${sessionJwt}` })), 401);
  });

  it("rejects malformed JWT (bad signature)", async () => {
    const malformed = "eyJhbGciOiJIUzI1NiJ9.eyJ0eXAiOiJvYXV0aCJ9.badsig";
    dbGetResponses = [];
    await expectStatus(authenticate(req({ Authorization: `Bearer ${malformed}` })), 401);
  });

  it("intersects JWT scp with current token row scopes AND role ceiling", async () => {
    // JWT was issued with configs:write but token row was modified to only have configs:read
    const token = await issueJwt(["configs:read", "configs:write"]);
    dbGetResponses = [
      { ...mockTokenRow, scopes: ["configs:read"] }, // row no longer has configs:write
      { ...mockUser, role: "editor" },
    ];
    dbGetCallCount = 0;
    const ctx = await authenticate(req({ Authorization: `Bearer ${token}` }));
    // configs:write was in JWT but not in row — should be excluded
    expect(ctx.scopes).toContain("configs:read");
    expect(ctx.scopes).not.toContain("configs:write");
  });
});

// ── session path ───────────────────────────────────────────────────────────

describe("authenticate — session path", () => {
  it("returns full role ceiling for session user", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ userId: 1, email: "a@a", role: "editor" } as any);
    const ctx = await authenticate(req());
    expect(ctx.via).toBe("session");
    expect(ctx.userId).toBe(1);
    expect(ctx.scopes).toContain("configs:write");
    expect(ctx.scopes).toContain("nginx:reload");
    expect(ctx.tokenId).toBeUndefined();
  });

  it("401 when no session and no token", async () => {
    await expectStatus(authenticate(req()), 401);
  });
});
