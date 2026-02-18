import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encrypt, decrypt } from "./encrypt";

describe("encrypt/decrypt", () => {
  const originalEnv = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    // Use a consistent test key
    process.env.ENCRYPTION_KEY = "test-encryption-key-for-unit-tests";
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ENCRYPTION_KEY = originalEnv;
    } else {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  it("encrypts and decrypts a string round-trip", () => {
    const plaintext = "my-secret-api-token-12345";
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it("produces output in iv:authTag:ciphertext base64 format", () => {
    const encrypted = encrypt("test");
    const parts = encrypted.split(":");

    expect(parts).toHaveLength(3);

    // Each part should be valid base64
    for (const part of parts) {
      expect(() => Buffer.from(part, "base64")).not.toThrow();
      expect(part.length).toBeGreaterThan(0);
    }
  });

  it("different plaintexts produce different ciphertexts", () => {
    const encrypted1 = encrypt("plaintext-one");
    const encrypted2 = encrypt("plaintext-two");

    expect(encrypted1).not.toBe(encrypted2);
  });

  it("same plaintext produces different ciphertexts (random IV)", () => {
    const encrypted1 = encrypt("same-text");
    const encrypted2 = encrypt("same-text");

    // Due to random IV, ciphertexts should differ
    expect(encrypted1).not.toBe(encrypted2);

    // But both should decrypt to the same value
    expect(decrypt(encrypted1)).toBe("same-text");
    expect(decrypt(encrypted2)).toBe("same-text");
  });

  it("decrypting tampered ciphertext throws an error", () => {
    const encrypted = encrypt("sensitive-data");
    const parts = encrypted.split(":");

    // Tamper with the ciphertext portion
    const tampered = parts[0] + ":" + parts[1] + ":" + "AAAA" + parts[2].slice(4);

    expect(() => decrypt(tampered)).toThrow();
  });

  it("decrypting tampered auth tag throws an error", () => {
    const encrypted = encrypt("sensitive-data");
    const parts = encrypted.split(":");

    // Tamper with the auth tag
    const tamperedTag = Buffer.from("0000000000000000").toString("base64");
    const tampered = parts[0] + ":" + tamperedTag + ":" + parts[2];

    expect(() => decrypt(tampered)).toThrow();
  });

  it("decrypting invalid format throws an error", () => {
    expect(() => decrypt("not-valid-format")).toThrow("Invalid encrypted data format");
    expect(() => decrypt("only:two")).toThrow("Invalid encrypted data format");
    expect(() => decrypt("")).toThrow("Invalid encrypted data format");
  });

  it("encrypts and decrypts an empty string", () => {
    const encrypted = encrypt("");
    const decrypted = decrypt(encrypted);

    expect(decrypted).toBe("");
  });

  it("encrypts and decrypts strings with special characters", () => {
    const plaintext = "token/with+special=chars&more!@#$%^*(){}[]";
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it("encrypts and decrypts unicode strings", () => {
    const plaintext = "unicode-token-\u{1F512}-\u{1F511}";
    const encrypted = encrypt(plaintext);
    const decrypted = decrypt(encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it("uses different keys for different ENCRYPTION_KEY values", () => {
    process.env.ENCRYPTION_KEY = "key-one";
    const encrypted = encrypt("secret");

    process.env.ENCRYPTION_KEY = "key-two";
    expect(() => decrypt(encrypted)).toThrow();
  });

  it("works with fallback dev key when ENCRYPTION_KEY is not set", () => {
    delete process.env.ENCRYPTION_KEY;

    const encrypted = encrypt("dev-secret");
    const decrypted = decrypt(encrypted);

    expect(decrypted).toBe("dev-secret");
  });
});
