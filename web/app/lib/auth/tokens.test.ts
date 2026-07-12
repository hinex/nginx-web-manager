import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/db/connection", () => {
  const chain: Record<string, any> = {};
  for (const m of ["insert", "values", "returning", "select", "from", "where", "orderBy", "update", "set"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.get = vi.fn();
  chain.all = vi.fn(() => []);
  chain.run = vi.fn();
  return { db: chain };
});

vi.mock("~/lib/db/schema", () => ({
  apiTokens: {
    id: "id",
    userId: "user_id",
    name: "name",
    tokenHash: "token_hash",
    scopes: "scopes",
    expiresAt: "expires_at",
    lastUsedAt: "last_used_at",
    revokedAt: "revoked_at",
    createdAt: "created_at",
  },
}));

import { db } from "~/lib/db/connection";
import {
  TOKEN_PREFIX,
  hashToken,
  generateTokenSecret,
  createApiToken,
  verifyApiToken,
  revokeApiToken,
  listApiTokens,
} from "./tokens";

const mockDb = db as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateTokenSecret", () => {
  it("produces ngm_-prefixed base64url token of expected length", () => {
    const { token, tokenHash } = generateTokenSecret();
    expect(token).toMatch(/^ngm_[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toBe(hashToken(token));
  });

  it("produces unique tokens", () => {
    expect(generateTokenSecret().token).not.toBe(generateTokenSecret().token);
  });
});

describe("hashToken", () => {
  it("is deterministic sha256 hex", () => {
    const h = hashToken("ngm_test");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("ngm_test")).toBe(h);
    expect(hashToken("ngm_other")).not.toBe(h);
  });
});

describe("createApiToken", () => {
  it("rejects empty name", () => {
    expect(() =>
      createApiToken({ userId: 1, role: "admin", name: "  ", scopes: ["configs:read"], expiresInDays: null })
    ).toThrow(/name/i);
  });

  it("rejects empty scopes", () => {
    expect(() =>
      createApiToken({ userId: 1, role: "admin", name: "t", scopes: [], expiresInDays: null })
    ).toThrow(/scope/i);
  });

  it("rejects unknown scope", () => {
    expect(() =>
      createApiToken({ userId: 1, role: "admin", name: "t", scopes: ["root:everything"], expiresInDays: null })
    ).toThrow(/unknown scope/i);
  });

  it("rejects scope above role ceiling", () => {
    expect(() =>
      createApiToken({ userId: 1, role: "viewer", name: "t", scopes: ["configs:write"], expiresInDays: null })
    ).toThrow(/exceeds role ceiling/i);
  });

  it("inserts and returns the plaintext token once", () => {
    mockDb.get.mockReturnValueOnce({ id: 5, userId: 1, name: "t", scopes: ["configs:read"] });
    const { token, record } = createApiToken({
      userId: 1,
      role: "editor",
      name: "t",
      scopes: ["configs:read"],
      expiresInDays: 30,
    });
    expect(token).toMatch(/^ngm_/);
    expect(record.id).toBe(5);
    const inserted = mockDb.values.mock.calls[0][0];
    expect(inserted.tokenHash).toBe(hashToken(token));
    expect(inserted.expiresAt).toBeInstanceOf(Date);
    expect(inserted.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
  });

  it("expiresAt is null for never-expiring tokens", () => {
    mockDb.get.mockReturnValueOnce({ id: 6 });
    createApiToken({ userId: 1, role: "admin", name: "t", scopes: ["stats:read"], expiresInDays: null });
    expect(mockDb.values.mock.calls[0][0].expiresAt).toBeNull();
  });
});

describe("verifyApiToken", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 9,
    userId: 2,
    tokenHash: "",
    scopes: ["configs:read"],
    revokedAt: null,
    expiresAt: null,
    ...over,
  });

  it("rejects tokens without prefix", () => {
    expect(verifyApiToken("Bearer nope")).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects unknown token", () => {
    mockDb.get.mockReturnValueOnce(undefined);
    expect(verifyApiToken("ngm_x")).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects revoked token", () => {
    const t = "ngm_revoked";
    mockDb.get.mockReturnValueOnce(row({ tokenHash: hashToken(t), revokedAt: new Date() }));
    expect(verifyApiToken(t)).toEqual({ ok: false, reason: "revoked" });
  });

  it("rejects expired token", () => {
    const t = "ngm_expired";
    mockDb.get.mockReturnValueOnce(row({ tokenHash: hashToken(t), expiresAt: new Date(Date.now() - 1000) }));
    expect(verifyApiToken(t)).toEqual({ ok: false, reason: "expired" });
  });

  it("accepts valid token and touches lastUsedAt", () => {
    const t = "ngm_valid";
    mockDb.get.mockReturnValueOnce(row({ tokenHash: hashToken(t) }));
    expect(verifyApiToken(t)).toEqual({ ok: true, tokenId: 9, userId: 2, scopes: ["configs:read"] });
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb.run).toHaveBeenCalled();
  });
});

describe("revokeApiToken", () => {
  it("returns false when token belongs to another user", () => {
    mockDb.get.mockReturnValueOnce({ id: 9, userId: 999, revokedAt: null });
    expect(revokeApiToken(9, 2)).toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("revokes own token", () => {
    mockDb.get.mockReturnValueOnce({ id: 9, userId: 2, revokedAt: null });
    expect(revokeApiToken(9, 2)).toBe(true);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("returns false on double revoke (already revoked)", () => {
    mockDb.get.mockReturnValueOnce({ id: 9, userId: 2, revokedAt: new Date() });
    expect(revokeApiToken(9, 2)).toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("returns false when token does not exist", () => {
    mockDb.get.mockReturnValueOnce(undefined);
    expect(revokeApiToken(404, 2)).toBe(false);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe("listApiTokens", () => {
  it("selects only the given user's tokens, newest first, without tokenHash", () => {
    const rows = [
      { id: 2, name: "b", scopes: ["configs:read"], expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt: new Date() },
      { id: 1, name: "a", scopes: [], expiresAt: null, lastUsedAt: null, revokedAt: null, createdAt: new Date(0) },
    ];
    mockDb.all.mockReturnValueOnce(rows);
    const result = listApiTokens(2);
    expect(result).toBe(rows);
    // select projection must not include token_hash
    const projection = mockDb.select.mock.calls[0][0];
    expect(projection).toBeDefined();
    expect(Object.values(projection)).not.toContain("token_hash");
    expect(mockDb.where).toHaveBeenCalled();
    expect(mockDb.orderBy).toHaveBeenCalled();
  });
});
