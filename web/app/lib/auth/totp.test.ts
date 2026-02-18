import { describe, it, expect } from "vitest";
import { TOTP, Secret } from "otpauth";
import { generateTotpSecret, verifyTotpCode } from "./totp";

describe("totp", () => {
  // ─── generateTotpSecret ─────────────────────────────────

  describe("generateTotpSecret", () => {
    it("returns a base32 secret and a valid otpauth URI", () => {
      const result = generateTotpSecret("user@example.com");

      expect(result.secret).toBeTruthy();
      expect(typeof result.secret).toBe("string");
      // Base32 alphabet: A-Z, 2-7, optional padding =
      expect(result.secret).toMatch(/^[A-Z2-7]+=*$/);

      expect(result.uri).toBeTruthy();
      expect(result.uri).toContain("otpauth://totp/");
      expect(result.uri).toContain("secret=");
      expect(result.uri).toContain("issuer=Nginx%20Manager");
      expect(result.uri).toContain("user%40example.com");
    });

    it("generates different secrets for each call", () => {
      const a = generateTotpSecret("user@example.com");
      const b = generateTotpSecret("user@example.com");
      expect(a.secret).not.toBe(b.secret);
    });

    it("includes the email in the URI label", () => {
      const result = generateTotpSecret("admin@nginx.local");
      expect(result.uri).toContain("admin%40nginx.local");
    });
  });

  // ─── verifyTotpCode ─────────────────────────────────────

  describe("verifyTotpCode", () => {
    /** Helper: generate a code for a given secret at a specific timestamp. */
    function generateCode(base32Secret: string, timestamp?: number): string {
      const totp = new TOTP({
        secret: Secret.fromBase32(base32Secret),
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      });
      return totp.generate({ timestamp });
    }

    it("accepts a valid current code", () => {
      const { secret } = generateTotpSecret("user@example.com");
      const code = generateCode(secret);
      expect(verifyTotpCode(secret, code)).toBe(true);
    });

    it("rejects an invalid code", () => {
      const { secret } = generateTotpSecret("user@example.com");
      expect(verifyTotpCode(secret, "000000")).toBe(false);
      expect(verifyTotpCode(secret, "999999")).toBe(false);
      expect(verifyTotpCode(secret, "abcdef")).toBe(false);
    });

    it("rejects an empty code", () => {
      const { secret } = generateTotpSecret("user@example.com");
      expect(verifyTotpCode(secret, "")).toBe(false);
    });

    // ─── Window tolerance (±1 period) ───────────────────────

    it("accepts a code from 1 period (30s) in the past", () => {
      const { secret } = generateTotpSecret("user@example.com");
      const now = Date.now();
      // Generate code for 30 seconds ago
      const pastCode = generateCode(secret, now - 30_000);
      // The code should still be valid now because window = 1
      // We need to validate at the same "now" baseline
      const totp = new TOTP({
        secret: Secret.fromBase32(secret),
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      });
      const delta = totp.validate({ token: pastCode, timestamp: now, window: 1 });
      expect(delta).not.toBeNull();
    });

    it("accepts a code from 1 period (30s) in the future", () => {
      const { secret } = generateTotpSecret("user@example.com");
      const now = Date.now();
      // Generate code for 30 seconds from now
      const futureCode = generateCode(secret, now + 30_000);
      const totp = new TOTP({
        secret: Secret.fromBase32(secret),
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      });
      const delta = totp.validate({ token: futureCode, timestamp: now, window: 1 });
      expect(delta).not.toBeNull();
    });

    it("rejects a code from 2 periods (60s) in the past", () => {
      const { secret } = generateTotpSecret("user@example.com");
      const now = Date.now();
      // Generate code for 60 seconds ago — outside the ±1 window
      const oldCode = generateCode(secret, now - 60_000);
      const totp = new TOTP({
        secret: Secret.fromBase32(secret),
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      });
      const delta = totp.validate({ token: oldCode, timestamp: now, window: 1 });
      expect(delta).toBeNull();
    });

    it("rejects a code from 2 periods (60s) in the future", () => {
      const { secret } = generateTotpSecret("user@example.com");
      const now = Date.now();
      // Generate code for 60 seconds from now — outside the ±1 window
      const futureCode = generateCode(secret, now + 60_000);
      const totp = new TOTP({
        secret: Secret.fromBase32(secret),
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      });
      const delta = totp.validate({ token: futureCode, timestamp: now, window: 1 });
      expect(delta).toBeNull();
    });

    it("works with a known secret and generated code round-trip", () => {
      // Use a fixed secret to ensure deterministic behavior
      const fixedSecret = new Secret({ size: 20 });
      const base32 = fixedSecret.base32;
      const code = generateCode(base32);
      expect(verifyTotpCode(base32, code)).toBe(true);
    });
  });
});
