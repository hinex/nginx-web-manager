import { TOTP, Secret } from "otpauth";

const ISSUER = "Nginx Manager";
const ALGORITHM = "SHA1";
const DIGITS = 6;
const PERIOD = 30;

/**
 * Generates a new TOTP secret and otpauth:// URI for a given email.
 * The secret can be stored in the database and the URI used to generate a QR code.
 */
export function generateTotpSecret(email: string): {
  secret: string;
  uri: string;
} {
  const secret = new Secret({ size: 20 });

  const totp = new TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
    secret,
  });

  return {
    secret: secret.base32,
    uri: totp.toString(),
  };
}

/**
 * Verifies a TOTP code against a base32-encoded secret.
 * Uses a window of +/-1 to allow for clock drift (codes from 30s before/after are accepted).
 */
export function verifyTotpCode(secret: string, code: string): boolean {
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
    secret: Secret.fromBase32(secret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

// Tracks the last accepted time-step per user to prevent replay of a
// just-used TOTP code within its validity window. In-memory: single-process
// server; a restart only re-opens the current ~30-90s window.
const lastUsedStep = new Map<number, number>();

/**
 * Verifies a TOTP code and enforces one-time use: a code matching a time-step
 * that is <= the last accepted step for this user is rejected (replay).
 */
export function verifyTotpCodeOnce(
  userId: number,
  secret: string,
  code: string
): boolean {
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
    secret: Secret.fromBase32(secret),
  });

  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return false;

  const step = Math.floor(Date.now() / (PERIOD * 1000)) + delta;
  const last = lastUsedStep.get(userId);
  if (last !== undefined && step <= last) return false;

  lastUsedStep.set(userId, step);
  return true;
}
