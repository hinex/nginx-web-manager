/**
 * Unit tests for checkMtls() in middleware.ts.
 *
 * These tests exercise the real implementation with a mocked DB so we verify
 * the actual header/settings logic without hitting SQLite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock ────────────────────────────────────────────────────────────────
// Simulates the single db.get() call inside checkMtls.
let dbGetResponse: unknown = undefined;

vi.mock("~/lib/db/connection", () => {
  const chain: Record<string, any> = {};
  for (const m of ["select", "from", "where"]) chain[m] = vi.fn(() => chain);
  chain.get = vi.fn(() => dbGetResponse);
  return { db: chain };
});

vi.mock("~/lib/db/schema", () => ({
  settings: { key: "key", value: "value" },
  users: { id: "id" },
}));

import { checkMtls } from "./middleware";
import { db } from "~/lib/db/connection";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/mcp", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbGetResponse = undefined;
});

// ── flag off / absent ──────────────────────────────────────────────────────

describe("checkMtls — flag off or absent", () => {
  it("no-ops when require_mtls row is absent (undefined)", async () => {
    dbGetResponse = undefined;
    // Any header value — should not throw
    await expect(
      checkMtls(makeRequest())
    ).resolves.toBeUndefined();
  });

  it("no-ops when require_mtls value is 'false'", async () => {
    dbGetResponse = { key: "require_mtls", value: "false" };
    await expect(
      checkMtls(makeRequest())
    ).resolves.toBeUndefined();
  });

  it("no-ops when require_mtls value is '' (empty)", async () => {
    dbGetResponse = { key: "require_mtls", value: "" };
    await expect(
      checkMtls(makeRequest())
    ).resolves.toBeUndefined();
  });

  it("ignores X-Client-Verify header when flag is off", async () => {
    dbGetResponse = { key: "require_mtls", value: "false" };
    // Even a missing/wrong header should not cause a rejection
    await expect(
      checkMtls(makeRequest({ "x-client-verify": "FAILED" }))
    ).resolves.toBeUndefined();
  });
});

// ── flag on + missing / wrong header ──────────────────────────────────────

describe("checkMtls — flag on, header missing or wrong", () => {
  beforeEach(() => {
    dbGetResponse = { key: "require_mtls", value: "true" };
  });

  it("throws 401 when X-Client-Verify header is absent", async () => {
    await expect(checkMtls(makeRequest())).rejects.toBeInstanceOf(Response);
    try {
      await checkMtls(makeRequest());
    } catch (err) {
      expect((err as Response).status).toBe(401);
      const body = await (err as Response).json();
      expect(body.error).toBe("mTLS required");
      expect(body.code).toBe("mtls_required");
    }
  });

  it("throws 401 when X-Client-Verify is 'FAILED'", async () => {
    try {
      await checkMtls(makeRequest({ "x-client-verify": "FAILED" }));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Response).status).toBe(401);
      const body = await (err as Response).json();
      expect(body.code).toBe("mtls_required");
    }
  });

  it("throws 401 when X-Client-Verify is 'NONE'", async () => {
    try {
      await checkMtls(makeRequest({ "x-client-verify": "NONE" }));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Response).status).toBe(401);
    }
  });

  it("throws 401 when X-Client-Verify is 'success' (case-sensitive check)", async () => {
    // Header value must be exactly 'SUCCESS'
    try {
      await checkMtls(makeRequest({ "x-client-verify": "success" }));
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Response).status).toBe(401);
    }
  });
});

// ── fail-closed on settings read error ─────────────────────────────────────

describe("checkMtls — settings read failure", () => {
  it("fails closed (401) even with SUCCESS header when the settings read throws", async () => {
    vi.mocked((db as any).get).mockImplementationOnce(() => {
      throw new Error("db unavailable");
    });
    try {
      await checkMtls(makeRequest({ "x-client-verify": "SUCCESS" }));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(401);
      const body = await (err as Response).json();
      expect(body.code).toBe("mtls_required");
    }
  });
});

// ── flag on + SUCCESS ──────────────────────────────────────────────────────

describe("checkMtls — flag on, SUCCESS header present", () => {
  it("resolves (no-op) when X-Client-Verify is exactly 'SUCCESS'", async () => {
    dbGetResponse = { key: "require_mtls", value: "true" };
    await expect(
      checkMtls(makeRequest({ "x-client-verify": "SUCCESS" }))
    ).resolves.toBeUndefined();
  });
});
