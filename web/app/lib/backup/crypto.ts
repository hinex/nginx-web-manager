/**
 * Password-based AES-256-GCM encryption for backup archives.
 *
 * Binary format of encrypted output:
 *   [salt: 16 bytes][iv: 12 bytes][authTag: 16 bytes][ciphertext: rest]
 *
 * Key is derived from the user-provided password using scrypt.
 * Separate from the env-var-based crypto in ~/lib/crypto/encrypt.ts.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH) as Buffer;
}

/**
 * Encrypt a buffer with AES-256-GCM using a user-provided password.
 * Returns a single Buffer: salt + iv + authTag + ciphertext.
 */
export function encryptBackup(data: Buffer, password: string): Buffer {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([salt, iv, authTag, encrypted]);
}

/**
 * Decrypt a buffer that was encrypted with encryptBackup().
 * Expects format: salt (16) + iv (12) + authTag (16) + ciphertext.
 * Throws on invalid password or corrupted data.
 */
export function decryptBackup(encryptedData: Buffer, password: string): Buffer {
  const minLength = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
  if (encryptedData.length < minLength) {
    throw new Error("Encrypted data is too short to be valid");
  }

  const salt = encryptedData.subarray(0, SALT_LENGTH);
  const iv = encryptedData.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = encryptedData.subarray(
    SALT_LENGTH + IV_LENGTH,
    SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
  );
  const ciphertext = encryptedData.subarray(minLength);

  const key = deriveKey(password, salt);

  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted;
}
