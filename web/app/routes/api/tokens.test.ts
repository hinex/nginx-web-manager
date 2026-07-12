import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ userId: 1, role: "editor" })),
  requireAdmin: vi.fn(async () => ({ userId: 1, role: "admin" })),
}));
vi.mock("~/lib/auth/tokens", () => ({
  createApiToken: vi.fn(),
  listApiTokens: vi.fn(() => []),
  revokeApiToken: vi.fn(() => true),
}));
vi.mock("~/lib/audit/log", () => ({ logAudit: vi.fn() }));
vi.mock("~/lib/db/connection", () => {
  const chain: Record<string, any> = {};
  for (const m of ["select", "from", "where", "update", "set", "insert", "values"]) {
    chain[m] = vi.fn(() => chain);
  }
  chain.get = vi.fn(() => undefined);
  chain.run = vi.fn();
  return { db: chain };
});
vi.mock("~/lib/db/schema", () => ({ settings: { key: "key", value: "value" } }));

import { requireAdmin } from "~/lib/auth/middleware";
import { createApiToken, revokeApiToken } from "~/lib/auth/tokens";
import { action, loader } from "./tokens";

function post(body: Record<string, unknown>) {
  return action({
    request: new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  } as any);
}

beforeEach(() => vi.resetAllMocks());

describe("loader", () => {
  it("lists tokens without exposing hashes", async () => {
    const res = await loader({
      request: new Request("http://localhost/api/tokens"),
    } as any);
    const body = await res.json();
    expect(body.tokens).toEqual([]);
  });
});

describe("action create", () => {
  it("returns the plaintext token once", async () => {
    vi.mocked(createApiToken).mockReturnValue({
      token: "ngm_secret",
      record: { id: 4, name: "t", scopes: ["configs:read"], expiresAt: null, createdAt: new Date() } as any,
    });
    const res = await post({
      action: "create",
      name: "t",
      scopes: ["configs:read"],
      expiresInDays: 30,
    });
    const body = await res.json();
    expect(body.token).toBe("ngm_secret");
    expect(body.record.id).toBe(4);
  });

  it("rejects invalid expiry preset", async () => {
    const res = await post({ action: "create", name: "t", scopes: ["configs:read"], expiresInDays: 5 });
    expect(res.status).toBe(400);
  });

  it("maps ceiling violations to 400", async () => {
    vi.mocked(createApiToken).mockImplementation(() => {
      throw new Error("Scope configs:write exceeds role ceiling");
    });
    const res = await post({ action: "create", name: "t", scopes: ["configs:write"], expiresInDays: null });
    expect(res.status).toBe(400);
  });
});

describe("action revoke", () => {
  it("404 when token not found or foreign", async () => {
    vi.mocked(revokeApiToken).mockReturnValue(false);
    const res = await post({ action: "revoke", tokenId: 99 });
    expect(res.status).toBe(404);
  });

  it("revokes own token", async () => {
    const res = await post({ action: "revoke", tokenId: 4 });
    expect((await res.json()).revoked).toBe(true);
  });
});

describe("action set_mcp_secret", () => {
  it("requires admin", async () => {
    await post({ action: "set_mcp_secret", enabled: true });
    expect(requireAdmin).toHaveBeenCalled();
  });

  it("generates a secret when enabled and clears when disabled", async () => {
    const on = await (await post({ action: "set_mcp_secret", enabled: true })).json();
    expect(on.mcpPathSecret).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    const off = await (await post({ action: "set_mcp_secret", enabled: false })).json();
    expect(off.mcpPathSecret).toBeNull();
  });
});
