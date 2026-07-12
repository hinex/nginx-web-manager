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
vi.mock("~/lib/db/connection", () => {
  const chain: Record<string, any> = {};
  for (const m of ["select", "from", "where"]) chain[m] = vi.fn(() => chain);
  chain.get = vi.fn();
  return { db: chain };
});
vi.mock("~/lib/db/schema", () => ({ users: { id: "id" } }));

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
});

describe("authenticate — bearer path", () => {
  it("returns token context with scopes intersected against current role", async () => {
    vi.mocked(verifyApiToken).mockReturnValue({
      ok: true,
      tokenId: 7,
      userId: 3,
      scopes: ["configs:read", "configs:write"],
    });
    mockDb.get.mockReturnValue({ id: 3, role: "viewer" });
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
    mockDb.get.mockReturnValue(undefined);
    await expectStatus(authenticate(req({ Authorization: "Bearer ngm_abc" })), 401);
  });

  it("429 when rate limited", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: false, retryAfterMs: 60000 });
    await expectStatus(authenticate(req({ Authorization: "Bearer ngm_abc" })), 429);
    expect(verifyApiToken).not.toHaveBeenCalled();
  });
});

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
