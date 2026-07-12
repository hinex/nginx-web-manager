/**
 * Tests for POST /api/v1/oauth/token (client_credentials grant)
 * and the corresponding JWT bearer branch in authenticate().
 *
 * Strategy: mock DB and auth helpers; call the route handler and authenticate()
 * directly (no HTTP server needed).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mocks ──────────────────────────────────────────────────────────────
const mockTokenRow = {
  id: 42,
  userId: 7,
  name: "test-token",
  tokenHash: "abc",
  scopes: ["configs:read", "configs:write", "stats:read"],
  expiresAt: null as Date | null,
  revokedAt: null as Date | null,
  lastUsedAt: null,
  createdAt: new Date(),
};

const mockUser = {
  id: 7,
  email: "user@example.com",
  name: "Test User",
  role: "editor",
  mustChangePassword: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  theme: null,
  password: "hashed",
};

// We need two independent "get" mocks — one for apiTokens queries (used by
// the route when it loads the token row after verifyApiToken), and one for
// users queries.  We simulate this by tracking call order.
let dbGetCallCount = 0;
let dbGetResponses: Array<unknown> = [];

vi.mock("~/lib/db/connection", () => {
  const chain: Record<string, any> = {};
  for (const m of ["select", "from", "where", "update", "set"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.get = vi.fn(() => {
    const resp = dbGetResponses[dbGetCallCount] ?? undefined;
    dbGetCallCount++;
    return resp;
  });
  chain.run = vi.fn();
  return { db: chain };
});

vi.mock("~/lib/db/schema", () => ({
  apiTokens: { id: "id", tokenHash: "token_hash", userId: "user_id" },
  users: { id: "id" },
  settings: { key: "key" },
}));

// ── Auth helper mocks ─────────────────────────────────────────────────────
vi.mock("~/lib/auth/middleware", () => ({
  checkIpWhitelist: vi.fn(async () => undefined),
  checkMtls: vi.fn(async () => undefined),
  getClientIp: vi.fn(() => "10.0.0.1"),
}));

vi.mock("~/lib/auth/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  recordFailedAttempt: vi.fn(),
}));

vi.mock("~/lib/auth/tokens", () => ({
  verifyApiToken: vi.fn(),
}));

vi.mock("~/lib/auth/session.server", () => ({
  getSessionUser: vi.fn(async () => null),
}));

// ── Imports after mocks ───────────────────────────────────────────────────
import { db } from "~/lib/db/connection";
import { verifyApiToken } from "~/lib/auth/tokens";
import { checkRateLimit, recordFailedAttempt } from "~/lib/auth/rate-limit";
import { checkMtls } from "~/lib/auth/middleware";
import { action, loader } from "./oauth-token";
import { authenticate } from "~/lib/auth/authenticate";

const mockDb = db as any;

// ── Helpers ───────────────────────────────────────────────────────────────

function makeFormRequest(
  params: Record<string, string>,
  method = "POST",
  extraHeaders: Record<string, string> = {}
): Request {
  return new Request("http://localhost/api/v1/oauth/token", {
    method,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...extraHeaders,
    },
    body: new URLSearchParams(params).toString(),
  });
}

function defaultParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    grant_type: "client_credentials",
    client_id: "ngm-42",
    client_secret: "ngm_secret123",
    ...overrides,
  };
}

function setupHappyPath(scopes = mockTokenRow.scopes) {
  vi.mocked(verifyApiToken).mockReturnValue({
    ok: true,
    tokenId: 42,
    userId: 7,
    scopes,
  });
  // Route loads tokenRow then user
  dbGetResponses = [{ ...mockTokenRow, scopes }, mockUser];
  dbGetCallCount = 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockReturnValue({ allowed: true });
  dbGetCallCount = 0;
  dbGetResponses = [];
});

// ═══════════════════════════════════════════════════════════════════════════
// Happy path
// ═══════════════════════════════════════════════════════════════════════════
describe("POST /api/v1/oauth/token — happy path", () => {
  it("issues a JWT with correct shape", async () => {
    setupHappyPath();
    const req = makeFormRequest(defaultParams());
    const res = await action({ request: req });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("access_token");
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(900);
    expect(typeof body.scope).toBe("string");
    // access_token should be a compact JWT
    expect(body.access_token).toMatch(/^ey[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("response carries Cache-Control: no-store and Pragma: no-cache (RFC 6749 §5.1)", async () => {
    setupHappyPath();
    const req = makeFormRequest(defaultParams());
    const res = await action({ request: req });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("granted scope matches effective intersection of token scopes ∩ role ceiling", async () => {
    // Token has configs:write but user is viewer (viewer ceiling lacks configs:write)
    vi.mocked(verifyApiToken).mockReturnValue({
      ok: true,
      tokenId: 42,
      userId: 7,
      scopes: ["configs:read", "configs:write"],
    });
    dbGetResponses = [
      { ...mockTokenRow, scopes: ["configs:read", "configs:write"] },
      { ...mockUser, role: "viewer" },
    ];
    dbGetCallCount = 0;
    const req = makeFormRequest(defaultParams());
    const res = await action({ request: req });
    const body = await res.json();
    const grantedScopes = body.scope.split(" ");
    // configs:write is NOT in viewer's ceiling — must be dropped
    expect(grantedScopes).toContain("configs:read");
    expect(grantedScopes).not.toContain("configs:write");
  });

  it("narrowed scope param: grants only the requested subset", async () => {
    setupHappyPath();
    const req = makeFormRequest(
      defaultParams({ scope: "configs:read" })
    );
    const res = await action({ request: req });
    const body = await res.json();
    expect(body.scope).toBe("configs:read");
  });

  it("no scope param → grants full effective scopes", async () => {
    setupHappyPath(["configs:read", "stats:read"]);
    // editor role ceiling has both
    const req = makeFormRequest(defaultParams());
    const res = await action({ request: req });
    const body = await res.json();
    const granted = body.scope.split(" ").sort();
    expect(granted).toEqual(["configs:read", "stats:read"].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// JWT accepted by authenticate()
// ═══════════════════════════════════════════════════════════════════════════
describe("JWT bearer accepted by authenticate()", () => {
  it("JWT issued by the endpoint is accepted by authenticate()", async () => {
    setupHappyPath(["configs:read", "stats:read"]);
    const tokenRes = await action({ request: makeFormRequest(defaultParams()) });
    const { access_token } = await tokenRes.json();

    // authenticate() needs to load the token row then user
    // It will call db.get() twice: once for apiTokens, once for users
    dbGetResponses = [{ ...mockTokenRow, scopes: ["configs:read", "stats:read"] }, mockUser];
    dbGetCallCount = 0;

    const authReq = new Request("http://localhost/api/test", {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const ctx = await authenticate(authReq);
    expect(ctx.via).toBe("token");
    expect(ctx.userId).toBe(7);
    expect(ctx.tokenId).toBe(42);
    expect(ctx.scopes).toContain("configs:read");
    expect(ctx.scopes).toContain("stats:read");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Wrong secret / mismatched client_id → invalid_client 401
// ═══════════════════════════════════════════════════════════════════════════
describe("invalid_client errors", () => {
  it("wrong secret → 401 invalid_client + recordFailedAttempt", async () => {
    vi.mocked(verifyApiToken).mockReturnValue({ ok: false, reason: "unknown" });
    dbGetResponses = [];
    const req = makeFormRequest(defaultParams({ client_secret: "ngm_wrong" }));
    const res = await action({ request: req });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_client");
    expect(recordFailedAttempt).toHaveBeenCalledWith("10.0.0.1");
  });

  it("mismatched client_id (token belongs to id 99, not 42) → 401 invalid_client", async () => {
    vi.mocked(verifyApiToken).mockReturnValue({
      ok: true,
      tokenId: 99,   // does NOT match ngm-42
      userId: 7,
      scopes: [],
    });
    dbGetResponses = [];
    const req = makeFormRequest(defaultParams());  // client_id = ngm-42
    const res = await action({ request: req });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_client");
    expect(recordFailedAttempt).toHaveBeenCalledWith("10.0.0.1");
  });

  it("malformed client_id → 401 invalid_client", async () => {
    dbGetResponses = [];
    const req = makeFormRequest(defaultParams({ client_id: "bad-format" }));
    const res = await action({ request: req });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid_client");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Over-broad scope → invalid_scope 400
// ═══════════════════════════════════════════════════════════════════════════
describe("invalid_scope error", () => {
  it("requesting scope not in effective → 400 invalid_scope", async () => {
    setupHappyPath(["configs:read"]); // token only has configs:read
    const req = makeFormRequest(defaultParams({ scope: "configs:read configs:write" }));
    const res = await action({ request: req });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_scope");
  });

  it("requesting scope beyond role ceiling → 400 invalid_scope", async () => {
    // Token has nginx:reload but user is viewer (ceiling doesn't include it)
    vi.mocked(verifyApiToken).mockReturnValue({
      ok: true,
      tokenId: 42,
      userId: 7,
      scopes: ["nginx:reload"],
    });
    dbGetResponses = [
      { ...mockTokenRow, scopes: ["nginx:reload"] },
      { ...mockUser, role: "viewer" },
    ];
    dbGetCallCount = 0;
    const req = makeFormRequest(defaultParams({ scope: "nginx:reload" }));
    const res = await action({ request: req });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_scope");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Revoked token: endpoint rejects AND authenticate() rejects issued JWT
// ═══════════════════════════════════════════════════════════════════════════
describe("revoked token liveness", () => {
  it("verifyApiToken returning revoked → 401 invalid_client from endpoint", async () => {
    vi.mocked(verifyApiToken).mockReturnValue({ ok: false, reason: "revoked" });
    dbGetResponses = [];
    const req = makeFormRequest(defaultParams());
    const res = await action({ request: req });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_client");
  });

  it("issued JWT rejected by authenticate() when token row is revoked", async () => {
    // First, issue a valid JWT
    setupHappyPath(["configs:read"]);
    const tokenRes = await action({ request: makeFormRequest(defaultParams()) });
    const { access_token } = await tokenRes.json();

    // Now simulate token being revoked — authenticate() loads a revoked row
    dbGetResponses = [
      { ...mockTokenRow, scopes: ["configs:read"], revokedAt: new Date() },
    ];
    dbGetCallCount = 0;

    const authReq = new Request("http://localhost/api/test", {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    let threw = false;
    try {
      await authenticate(authReq);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(401);
    }
    expect(threw).toBe(true);
    expect(recordFailedAttempt).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Expired JWT rejected by authenticate()
// ═══════════════════════════════════════════════════════════════════════════
describe("expired JWT", () => {
  it("authenticate() rejects an expired JWT", async () => {
    // Sign a genuinely expired JWT (past exp) with the real secret so this
    // exercises jose's ERR_JWT_EXPIRED path, not the bad-signature path.
    const { SignJWT } = await import("jose");
    const { getJwtSecret } = await import("~/lib/auth/jwt.server");
    const expiredJwt = await new SignJWT({
      sub: "7",
      tid: 42,
      scp: ["configs:read"],
      typ: "oauth",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(getJwtSecret());
    dbGetResponses = [];
    const authReq = new Request("http://localhost/api/test", {
      headers: { Authorization: `Bearer ${expiredJwt}` },
    });
    let threw = false;
    try {
      await authenticate(authReq);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(401);
    }
    expect(threw).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// typ missing → rejected by authenticate()
// ═══════════════════════════════════════════════════════════════════════════
describe("typ claim enforcement", () => {
  it("session JWT (no typ=oauth) is rejected by authenticate()", async () => {
    // Use the session createToken which lacks typ:"oauth"
    const { createToken } = await import("~/lib/auth/jwt.server");
    const sessionJwt = await createToken({ userId: 7, email: "u@test.com", role: "editor" });

    dbGetResponses = [];
    const authReq = new Request("http://localhost/api/test", {
      headers: { Authorization: `Bearer ${sessionJwt}` },
    });
    let threw = false;
    try {
      await authenticate(authReq);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(401);
    }
    expect(threw).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Opaque ngm_ tokens still work (regression)
// ═══════════════════════════════════════════════════════════════════════════
describe("opaque token regression", () => {
  it("ngm_ bearer token still works through authenticate()", async () => {
    vi.mocked(verifyApiToken).mockReturnValue({
      ok: true,
      tokenId: 7,
      userId: 3,
      scopes: ["configs:read", "configs:write"],
    });
    // authenticate() calls db.get() once for users
    dbGetResponses = [{ ...mockUser, id: 3, role: "viewer" }];
    dbGetCallCount = 0;

    const authReq = new Request("http://localhost/api/test", {
      headers: { Authorization: "Bearer ngm_some_opaque_token" },
    });
    const ctx = await authenticate(authReq);
    expect(ctx.via).toBe("token");
    expect(ctx.userId).toBe(3);
    expect(ctx.tokenId).toBe(7);
    expect(ctx.scopes).toEqual(["configs:read"]); // write dropped by viewer ceiling
    // verifyApiToken was called (not the JWT path)
    expect(verifyApiToken).toHaveBeenCalledWith("ngm_some_opaque_token");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rate limit
// ═══════════════════════════════════════════════════════════════════════════
describe("rate limiting", () => {
  it("rate-limited request → 429 from endpoint", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: false, retryAfterMs: 60000 });
    const req = makeFormRequest(defaultParams());
    const res = await action({ request: req });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("too_many_requests");
  });

  it("repeated bad secrets trigger recordFailedAttempt", async () => {
    vi.mocked(verifyApiToken).mockReturnValue({ ok: false, reason: "unknown" });
    dbGetResponses = [];
    for (let i = 0; i < 3; i++) {
      await action({ request: makeFormRequest(defaultParams({ client_secret: "ngm_bad" })) });
    }
    expect(recordFailedAttempt).toHaveBeenCalledTimes(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 415 wrong Content-Type
// ═══════════════════════════════════════════════════════════════════════════
describe("content-type enforcement", () => {
  it("415 when Content-Type is application/json", async () => {
    const req = new Request("http://localhost/api/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(defaultParams()),
    });
    const res = await action({ request: req });
    expect(res.status).toBe(415);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
    expect((await res.json()).error).toBe("unsupported_media_type");
  });

  it("415 when Content-Type is missing", async () => {
    const req = new Request("http://localhost/api/v1/oauth/token", {
      method: "POST",
      body: new URLSearchParams(defaultParams()).toString(),
    });
    const res = await action({ request: req });
    expect(res.status).toBe(415);
  });

  it("accepts Content-Type with charset suffix", async () => {
    setupHappyPath();
    const req = new Request("http://localhost/api/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams(defaultParams()).toString(),
    });
    const res = await action({ request: req });
    expect(res.status).toBe(200);
    expect((await res.json()).token_type).toBe("Bearer");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 405 wrong method
// ═══════════════════════════════════════════════════════════════════════════
describe("method enforcement", () => {
  it("GET → 405 via loader", async () => {
    const req = new Request("http://localhost/api/v1/oauth/token", { method: "GET" });
    const res = await loader({ request: req });
    expect(res.status).toBe(405);
    const allow = res.headers.get("Allow");
    expect(allow).toContain("POST");
  });

  it("PUT → 405 via action", async () => {
    const req = new Request("http://localhost/api/v1/oauth/token", {
      method: "PUT",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    const res = await action({ request: req });
    expect(res.status).toBe(405);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// unsupported_grant_type
// ═══════════════════════════════════════════════════════════════════════════
describe("unsupported_grant_type", () => {
  it("grant_type=password → 400 unsupported_grant_type", async () => {
    const req = makeFormRequest(defaultParams({ grant_type: "password" }));
    const res = await action({ request: req });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// mTLS gate on oauth-token endpoint
// ═══════════════════════════════════════════════════════════════════════════
describe("mTLS gate — oauth-token endpoint", () => {
  it("mTLS failure returns 401 access_denied before credential check", async () => {
    vi.mocked(checkMtls).mockRejectedValueOnce(
      Response.json({ error: "mTLS required", code: "mtls_required" }, { status: 401 })
    );
    const req = makeFormRequest(defaultParams());
    const res = await action({ request: req });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("access_denied");
    // verifyApiToken must NOT have been called
    expect(verifyApiToken).not.toHaveBeenCalled();
  });

  it("mTLS passing allows the endpoint to proceed normally", async () => {
    vi.mocked(checkMtls).mockResolvedValueOnce(undefined);
    setupHappyPath();
    const req = makeFormRequest(defaultParams());
    const res = await action({ request: req });
    expect(res.status).toBe(200);
    expect(checkMtls).toHaveBeenCalledTimes(1);
  });
});
