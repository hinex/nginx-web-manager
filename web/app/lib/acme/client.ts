// web/app/lib/acme/client.ts

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const LETS_ENCRYPT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";
const LETS_ENCRYPT_STAGING = "https://acme-staging-v02.api.letsencrypt.org/directory";

const ACME_CHALLENGE_DIR = "/data/acme-challenge";
const CERTS_DIR = "/etc/letsencrypt/live";

interface AcmeDirectory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
}

export interface CertResult {
  success: boolean;
  error?: string;
  certPath?: string;
  keyPath?: string;
}

/**
 * Request a Let's Encrypt certificate for the given domains.
 * Uses HTTP-01 challenge. The Nginx proxy must serve
 * /.well-known/acme-challenge/ from /data/acme-challenge/
 */
export async function requestCertificate(
  domains: string[],
  staging?: boolean
): Promise<CertResult> {
  // For the initial implementation, this is a placeholder that generates
  // self-signed certificates or returns an error explaining the manual steps.
  // A full ACME implementation requires:
  // 1. JWK key pair generation
  // 2. Account registration
  // 3. Order creation
  // 4. Challenge fulfillment
  // 5. CSR generation
  // 6. Certificate download
  //
  // This would add significant complexity. For now, provide a helper
  // that explains how to use certbot externally.

  try {
    const primaryDomain = domains[0];
    const certDir = join(CERTS_DIR, primaryDomain);

    // Check if cert already exists
    if (existsSync(join(certDir, "fullchain.pem")) && existsSync(join(certDir, "privkey.pem"))) {
      return {
        success: true,
        certPath: join(certDir, "fullchain.pem"),
        keyPath: join(certDir, "privkey.pem"),
      };
    }

    // For now, return instructions for external certbot usage
    return {
      success: false,
      error: `To obtain a Let's Encrypt certificate for ${domains.join(", ")}, run:\n` +
        `certbot certonly --webroot -w /data/acme-challenge -d ${domains.join(" -d ")}\n` +
        `Or use the mounted /etc/letsencrypt volume with an external certbot container.`,
    };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Check if a certificate exists and return its expiry info
 */
export function getCertificateInfo(domain: string): {
  exists: boolean;
  certPath?: string;
  keyPath?: string;
} {
  const certDir = join(CERTS_DIR, domain);
  const certPath = join(certDir, "fullchain.pem");
  const keyPath = join(certDir, "privkey.pem");

  if (existsSync(certPath) && existsSync(keyPath)) {
    return { exists: true, certPath, keyPath };
  }
  return { exists: false };
}

/**
 * Write an ACME challenge response file for HTTP-01 validation.
 * Nginx should serve /.well-known/acme-challenge/{token} from this directory.
 */
export function writeChallenge(token: string, content: string): void {
  mkdirSync(ACME_CHALLENGE_DIR, { recursive: true });
  writeFileSync(join(ACME_CHALLENGE_DIR, token), content);
}

/**
 * Clean up an ACME challenge file after validation
 */
export function cleanChallenge(token: string): void {
  try {
    const path = join(ACME_CHALLENGE_DIR, token);
    if (existsSync(path)) {
      const { unlinkSync } = require("fs");
      unlinkSync(path);
    }
  } catch {}
}
