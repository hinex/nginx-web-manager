import { describe, it, expect } from "vitest";
import { createSessionCookie, clearSessionCookie, requireRole } from "./session.server";
import type { TokenPayload } from "./jwt.server";

describe("createSessionCookie", () => {
  it("includes the token value", () => {
    const cookie = createSessionCookie("my-jwt-token");
    expect(cookie).toContain("nm_session=my-jwt-token");
  });

  it("includes HttpOnly flag", () => {
    const cookie = createSessionCookie("token");
    expect(cookie).toContain("HttpOnly");
  });

  it("includes SameSite=Lax", () => {
    const cookie = createSessionCookie("token");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("includes Path=/", () => {
    const cookie = createSessionCookie("token");
    expect(cookie).toContain("Path=/");
  });

  it("includes Max-Age=86400", () => {
    const cookie = createSessionCookie("token");
    expect(cookie).toContain("Max-Age=86400");
  });
});

describe("clearSessionCookie", () => {
  it("sets Max-Age=0 and clears value", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("nm_session=");
  });
});

describe("requireRole", () => {
  const adminUser = {
    userId: 1,
    email: "a@b.com",
    role: "admin",
  } as TokenPayload;

  const viewerUser = {
    userId: 2,
    email: "v@b.com",
    role: "viewer",
  } as TokenPayload;

  it("returns user when role matches", () => {
    const result = requireRole(adminUser, "admin");
    expect(result).toBe(adminUser);
  });

  it("allows when user has one of multiple roles", () => {
    const result = requireRole(adminUser, "admin", "editor");
    expect(result).toBe(adminUser);
  });

  it("throws 403 for null user", () => {
    try {
      requireRole(null, "admin");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("throws 403 for wrong role", () => {
    try {
      requireRole(viewerUser, "admin");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  // ─── Security: role escalation / edge cases ─────────────

  it("throws 403 for empty roles list", () => {
    // No roles provided → always forbidden
    try {
      requireRole(adminUser);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("role check is case-sensitive", () => {
    // "Admin" != "admin" — should not match
    try {
      requireRole(adminUser, "Admin");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("throws 403 for user with tampered role", () => {
    const tamperedUser = {
      userId: 1,
      email: "a@b.com",
      role: "admin; DROP TABLE users",
    } as TokenPayload;
    try {
      requireRole(tamperedUser, "admin");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });

  it("throws 403 for undefined user", () => {
    try {
      requireRole(undefined as any, "admin");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });
});

// ─── Security: cookie handling edge cases ──────────────

describe("createSessionCookie security", () => {
  it("does not include Secure flag in non-production", () => {
    const cookie = createSessionCookie("token");
    // NODE_ENV is not "production" in test, so Secure should be absent
    expect(cookie).not.toContain("Secure");
  });

  it("handles token with special characters", () => {
    // JWT tokens are base64url, but test edge case
    const cookie = createSessionCookie("a;b=c&d<e>f");
    expect(cookie).toContain("nm_session=a;b=c&d<e>f");
  });

  it("handles empty token", () => {
    const cookie = createSessionCookie("");
    expect(cookie).toContain("nm_session=");
    expect(cookie).toContain("HttpOnly");
  });
});

describe("clearSessionCookie security", () => {
  it("includes HttpOnly flag", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain("HttpOnly");
  });

  it("does not contain any token value", () => {
    const cookie = clearSessionCookie();
    // After "nm_session=" there should be nothing before the next ";"
    const match = cookie.match(/nm_session=([^;]*)/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("");
  });
});
