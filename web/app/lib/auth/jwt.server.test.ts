import { describe, it, expect } from "vitest";
import { createToken, verifyToken } from "./jwt.server";

describe("jwt", () => {
  const payload = { userId: 1, email: "admin@test.com", role: "admin" };

  it("createToken returns a JWT string with 3 parts", async () => {
    const token = await createToken(payload);
    expect(token).toBeTruthy();
    expect(token.split(".")).toHaveLength(3);
  });

  it("verifyToken round-trips correctly", async () => {
    const token = await createToken(payload);
    const result = await verifyToken(token);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(1);
    expect(result!.email).toBe("admin@test.com");
    expect(result!.role).toBe("admin");
  });

  it("verifyToken returns null for invalid token", async () => {
    const result = await verifyToken("not-a-valid-token");
    expect(result).toBeNull();
  });

  it("verifyToken returns null for tampered token", async () => {
    const token = await createToken(payload);
    const tampered = token.slice(0, -5) + "XXXXX";
    const result = await verifyToken(tampered);
    expect(result).toBeNull();
  });

  // ─── Security: malformed / malicious tokens ────────────

  it("verifyToken returns null for empty string", async () => {
    expect(await verifyToken("")).toBeNull();
  });

  it("verifyToken returns null for just dots", async () => {
    expect(await verifyToken("..")).toBeNull();
    expect(await verifyToken("a.b.c")).toBeNull();
  });

  it("verifyToken returns null for SQL injection in token", async () => {
    expect(await verifyToken("'; DROP TABLE users; --")).toBeNull();
  });

  it("verifyToken returns null for XSS payload as token", async () => {
    expect(await verifyToken("<script>alert(1)</script>")).toBeNull();
  });

  it("verifyToken returns null for extremely long token", async () => {
    const huge = "a".repeat(100_000) + "." + "b".repeat(100_000) + "." + "c".repeat(100_000);
    expect(await verifyToken(huge)).toBeNull();
  });

  it("verifyToken rejects alg:none attack", async () => {
    // Classic JWT "alg:none" attack — craft a token with no signature
    const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
    const body = btoa(JSON.stringify({ userId: 999, email: "hacker@evil.com", role: "admin" }));
    const fakeToken = `${header}.${body}.`;
    expect(await verifyToken(fakeToken)).toBeNull();
  });

  it("verifyToken rejects token with modified payload", async () => {
    const token = await createToken(payload);
    const parts = token.split(".");
    // Decode payload, modify role, re-encode — signature won't match
    const decoded = JSON.parse(atob(parts[1]));
    decoded.role = "superadmin";
    decoded.userId = 999;
    parts[1] = btoa(JSON.stringify(decoded));
    const forged = parts.join(".");
    expect(await verifyToken(forged)).toBeNull();
  });

  it("different payloads produce different tokens", async () => {
    const token1 = await createToken(payload);
    const token2 = await createToken({ userId: 2, email: "other@test.com", role: "viewer" });
    expect(token1).not.toBe(token2);
  });

  it("token contains iat and exp claims", async () => {
    const token = await createToken(payload);
    const result = await verifyToken(token);
    expect(result).not.toBeNull();
    expect(result!.iat).toBeDefined();
    expect(result!.exp).toBeDefined();
    expect(typeof result!.iat).toBe("number");
    expect(typeof result!.exp).toBe("number");
    // exp should be ~24h after iat
    expect(result!.exp! - result!.iat!).toBeCloseTo(86400, -1);
  });
});
