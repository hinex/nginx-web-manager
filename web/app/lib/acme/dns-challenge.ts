// web/app/lib/acme/dns-challenge.ts

import { db } from "~/lib/db/connection";
import { dnsCredentials } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { decrypt } from "~/lib/crypto/encrypt";
import { CloudflareDnsProvider } from "~/lib/dns/cloudflare";
import type { DnsProvider, DnsZone } from "~/lib/dns/provider";
import { join } from "path";
import { existsSync } from "fs";
import type { CertResult } from "./client";

const CERTS_DIR = "/etc/letsencrypt/live";

/** Default propagation poll interval in milliseconds */
const PROPAGATION_POLL_INTERVAL_MS = 10_000;

/** Default propagation timeout in milliseconds (5 minutes) */
const PROPAGATION_TIMEOUT_MS = 300_000;

/**
 * Retrieves a DNS credential by ID from the database and decrypts the API token.
 */
function getDecryptedCredential(credentialId: number) {
  const cred = db
    .select()
    .from(dnsCredentials)
    .where(eq(dnsCredentials.id, credentialId))
    .get();
  if (!cred) return null;
  return { ...cred, apiToken: decrypt(cred.apiToken) };
}

/**
 * Instantiates a DnsProvider from the credential record.
 */
function getProvider(credential: {
  provider: string;
  apiToken: string;
}): DnsProvider {
  switch (credential.provider) {
    case "cloudflare":
      return new CloudflareDnsProvider(credential.apiToken);
    default:
      throw new Error(`Unsupported DNS provider: ${credential.provider}`);
  }
}

/**
 * Finds the matching DNS zone for a given domain.
 *
 * For example, given domain "app.example.com" and zones ["example.com", "other.com"],
 * returns the zone for "example.com". For wildcard domains like "*.example.com",
 * the leading "*." is stripped before matching.
 */
async function findZoneForDomain(
  provider: DnsProvider,
  domain: string
): Promise<DnsZone> {
  // Strip wildcard prefix if present
  const cleanDomain = domain.replace(/^\*\./, "");

  const zones = await provider.listZones();

  // Find the most specific (longest) matching zone
  const matchingZone = zones
    .filter((z) => {
      return (
        cleanDomain === z.name || cleanDomain.endsWith("." + z.name)
      );
    })
    .sort((a, b) => b.name.length - a.name.length)[0];

  if (!matchingZone) {
    throw new Error(
      `No matching DNS zone found for domain "${domain}". ` +
        `Available zones: ${zones.map((z) => z.name).join(", ")}`
    );
  }

  return matchingZone;
}

/**
 * Constructs the ACME challenge record name for a given domain.
 *
 * For "example.com" -> "_acme-challenge.example.com"
 * For "*.example.com" -> "_acme-challenge.example.com" (wildcard stripped)
 */
function getChallengeFqdn(domain: string): string {
  const cleanDomain = domain.replace(/^\*\./, "");
  return `_acme-challenge.${cleanDomain}`;
}

/**
 * Creates a DNS TXT record for ACME DNS-01 challenge validation.
 *
 * @param domain - The domain being validated (e.g., "example.com" or "*.example.com")
 * @param validationToken - The ACME challenge validation string to set as TXT content
 * @param credentialId - The ID of the DNS credential to use
 * @returns The created record ID and zone ID for later cleanup
 */
export async function createDnsChallenge(
  domain: string,
  validationToken: string,
  credentialId: number
): Promise<{ recordId: string; zoneId: string }> {
  const cred = getDecryptedCredential(credentialId);
  if (!cred) {
    throw new Error(`DNS credential with ID ${credentialId} not found`);
  }

  const provider = getProvider(cred);
  const zone = await findZoneForDomain(provider, domain);
  const challengeName = getChallengeFqdn(domain);

  const record = await provider.createRecord(zone.id, {
    type: "TXT",
    name: challengeName,
    content: validationToken,
    ttl: 120,
  });

  return { recordId: record.id, zoneId: zone.id };
}

/**
 * Removes a DNS TXT record previously created for ACME DNS-01 challenge validation.
 *
 * @param zoneId - The DNS zone ID containing the record
 * @param recordId - The record ID to delete
 * @param credentialId - The ID of the DNS credential to use
 */
export async function removeDnsChallenge(
  zoneId: string,
  recordId: string,
  credentialId: number
): Promise<void> {
  const cred = getDecryptedCredential(credentialId);
  if (!cred) {
    throw new Error(`DNS credential with ID ${credentialId} not found`);
  }

  const provider = getProvider(cred);
  await provider.deleteRecord(zoneId, recordId);
}

/**
 * Waits for a DNS TXT record to propagate by querying public DNS resolvers.
 *
 * Polls DNS over HTTPS (Cloudflare 1.1.1.1) to check whether the expected
 * TXT record value is visible. Returns true when the record is found, or
 * false if the timeout is reached.
 *
 * @param domain - The domain being validated (the _acme-challenge prefix is added automatically)
 * @param expectedToken - The TXT record value to wait for
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 5 minutes)
 * @returns true if the record was found before timeout, false otherwise
 */
export async function waitForPropagation(
  domain: string,
  expectedToken: string,
  timeoutMs: number = PROPAGATION_TIMEOUT_MS
): Promise<boolean> {
  const challengeFqdn = getChallengeFqdn(domain);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const found = await checkTxtRecord(challengeFqdn, expectedToken);
      if (found) {
        return true;
      }
    } catch {
      // DNS query failed; continue polling
    }

    // Wait before next poll
    await new Promise((resolve) =>
      setTimeout(resolve, PROPAGATION_POLL_INTERVAL_MS)
    );
  }

  return false;
}

/**
 * Checks if a TXT record with the expected value exists via DNS-over-HTTPS.
 */
async function checkTxtRecord(
  fqdn: string,
  expectedValue: string
): Promise<boolean> {
  // Query Cloudflare DNS-over-HTTPS for TXT records
  const url = `https://1.1.1.1/dns-query?name=${encodeURIComponent(fqdn)}&type=TXT`;
  const res = await fetch(url, {
    headers: { Accept: "application/dns-json" },
  });

  if (!res.ok) {
    return false;
  }

  const data = (await res.json()) as {
    Answer?: Array<{ type: number; data: string }>;
  };

  if (!data.Answer) {
    return false;
  }

  // TXT record type = 16
  return data.Answer.some((answer) => {
    if (answer.type !== 16) return false;
    // DNS TXT data is typically wrapped in quotes, e.g. "\"token-value\""
    const cleaned = answer.data.replace(/^"|"$/g, "");
    return cleaned === expectedValue;
  });
}

/**
 * Requests a wildcard (or regular) TLS certificate using certbot with DNS-01 validation.
 *
 * This function orchestrates the full flow:
 * 1. Creates _acme-challenge TXT records for each domain
 * 2. Waits for DNS propagation
 * 3. Runs certbot with --manual and --preferred-challenges dns
 * 4. Cleans up the TXT records after completion
 *
 * The certbot hook scripts are handled by writing temporary authenticator/cleanup
 * scripts that the certbot process uses via --manual-auth-hook and --manual-cleanup-hook.
 *
 * @param domains - Array of domains to include in the certificate (e.g., ["*.example.com", "example.com"])
 * @param credentialId - The ID of the DNS credential to use for DNS record management
 * @param staging - Whether to use Let's Encrypt staging (default: false)
 * @returns CertResult with success status and cert paths
 */
export async function requestWildcardCert(
  domains: string[],
  credentialId: number,
  staging: boolean = false
): Promise<CertResult> {
  if (!domains.length) {
    return { success: false, error: "At least one domain is required" };
  }

  // Validate that the credential exists before proceeding
  const cred = getDecryptedCredential(credentialId);
  if (!cred) {
    return {
      success: false,
      error: `DNS credential with ID ${credentialId} not found`,
    };
  }

  // Validate that all domains have matching zones
  const provider = getProvider(cred);
  for (const domain of domains) {
    try {
      await findZoneForDomain(provider, domain);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  const primaryDomain = domains[0].replace(/^\*\./, "");
  const certDir = join(CERTS_DIR, primaryDomain);

  try {
    // Build the certbot command arguments.
    // Certbot's --manual-auth-hook and --manual-cleanup-hook will call back
    // into our API to create and remove the _acme-challenge TXT records.
    const args = [
      "certonly",
      "--non-interactive",
      "--agree-tos",
      "--preferred-challenges",
      "dns",
      "--manual",
      "--manual-auth-hook",
      buildAuthHookCommand(credentialId),
      "--manual-cleanup-hook",
      buildCleanupHookCommand(credentialId),
      "--cert-name",
      primaryDomain,
    ];

    if (staging) {
      args.push("--staging");
    }

    // Add email if available, otherwise register without
    const email = process.env.ACME_EMAIL;
    if (email) {
      args.push("--email", email);
    } else {
      args.push("--register-unsafely-without-email");
    }

    for (const domain of domains) {
      args.push("-d", domain);
    }

    // Run certbot with the hook scripts that handle DNS record lifecycle
    const proc = Bun.spawn(["certbot", ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DNS_CREDENTIAL_ID: String(credentialId),
      },
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return {
        success: false,
        error:
          `certbot exited with code ${exitCode}.\n` +
          `stdout: ${stdout}\n` +
          `stderr: ${stderr}`,
      };
    }

    // Verify cert files exist
    const certPath = join(certDir, "fullchain.pem");
    const keyPath = join(certDir, "privkey.pem");

    if (existsSync(certPath) && existsSync(keyPath)) {
      return { success: true, certPath, keyPath };
    }

    return {
      success: false,
      error:
        "certbot completed but certificate files were not found at " +
        `${certDir}. stdout: ${stdout}`,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to run certbot: ${err.message}`,
    };
  }
}

/**
 * Builds the shell command for certbot's --manual-auth-hook.
 *
 * Certbot sets the following environment variables when calling the hook:
 * - CERTBOT_DOMAIN: the domain being authenticated
 * - CERTBOT_VALIDATION: the validation string for the DNS TXT record
 *
 * The hook creates the _acme-challenge TXT record and waits for propagation.
 */
function buildAuthHookCommand(credentialId: number): string {
  // Use the bundled acme-dns-hook script that is part of this application.
  // This script is invoked by certbot and communicates back through the API.
  const scriptPath = join(
    process.cwd(),
    "app/lib/acme/certbot-dns-hook.sh"
  );
  return `${scriptPath} auth ${credentialId}`;
}

/**
 * Builds the shell command for certbot's --manual-cleanup-hook.
 *
 * Certbot sets the following environment variables when calling the hook:
 * - CERTBOT_DOMAIN: the domain that was authenticated
 * - CERTBOT_VALIDATION: the validation string that was used
 * - CERTBOT_AUTH_OUTPUT: the output from the auth hook (contains recordId:zoneId)
 */
function buildCleanupHookCommand(credentialId: number): string {
  const scriptPath = join(
    process.cwd(),
    "app/lib/acme/certbot-dns-hook.sh"
  );
  return `${scriptPath} cleanup ${credentialId}`;
}
