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
