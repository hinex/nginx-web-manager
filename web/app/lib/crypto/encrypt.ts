import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SALT = "nginx-manager-encryption-salt";

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (secret && secret.length >= 16) {
    return scryptSync(secret, SALT, KEY_LENGTH);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "ENCRYPTION_KEY environment variable must be set to at least 16 characters in production"
    );
  }
  return scryptSync("dev-fallback-encryption-key-do-not-use-in-production", SALT, KEY_LENGTH);
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string in the format: iv:authTag:ciphertext
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const ivB64 = iv.toString("base64");
  const authTagB64 = authTag.toString("base64");
  const ciphertextB64 = encrypted.toString("base64");

  return `${ivB64}:${authTagB64}:${ciphertextB64}`;
}

/**
 * Decrypts a ciphertext string produced by encrypt().
 * Expects base64-encoded format: iv:authTag:ciphertext
 */
export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format");
  }

  const [ivB64, authTagB64, encryptedB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const encrypted = Buffer.from(encryptedB64, "base64");
  const key = getKey();

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}
