import { requireAdmin } from "~/lib/auth/middleware";
import {
  createDnsChallenge,
  removeDnsChallenge,
  waitForPropagation,
  requestWildcardCert,
} from "~/lib/acme/dns-challenge";

/**
 * Validates that a request is authorized, either via session (admin user)
 * or via the X-Hook-Key header (for certbot hook scripts).
 *
 * The hook key allows the certbot-dns-hook.sh script to call back into
 * the API without a user session, since it runs as a child process of certbot.
 */
async function requireAdminOrHookKey(request: Request): Promise<void> {
  const hookKey = request.headers.get("x-hook-key");
  const expectedKey = process.env.NGINX_MANAGER_HOOK_KEY;

  // If a valid hook key is provided, allow the request
  if (expectedKey && hookKey === expectedKey) {
    return;
  }

  // Otherwise, require admin session
  await requireAdmin(request);
}

export async function action({ request }: { request: Request }) {
  const body = await request.json();
  const { action: act } = body;

  try {
    switch (act) {
      /**
       * Request a wildcard (or regular) TLS certificate using DNS-01 validation.
       *
       * Body: { action: "request-wildcard-cert", domains: string[], credentialId: number, staging?: boolean }
       */
      case "request-wildcard-cert": {
        await requireAdmin(request);

        const { domains, credentialId, staging } = body;

        if (!domains || !Array.isArray(domains) || domains.length === 0) {
          return Response.json(
            { ok: false, error: "At least one domain is required" },
            { status: 400 }
          );
        }

        if (!credentialId) {
          return Response.json(
            { ok: false, error: "Credential ID is required" },
            { status: 400 }
          );
        }

        const result = await requestWildcardCert(
          domains,
          Number(credentialId),
          staging ?? false
        );

        if (result.success) {
          return Response.json({
            ok: true,
            certPath: result.certPath,
            keyPath: result.keyPath,
          });
        }

        return Response.json(
          { ok: false, error: result.error },
          { status: 500 }
        );
      }

      /**
       * Create an ACME DNS-01 challenge TXT record.
       *
       * Body: { action: "create-challenge", domain: string, validationToken: string, credentialId: number }
       *
       * Used by the certbot hook script and can also be called manually.
       */
      case "create-challenge": {
        await requireAdminOrHookKey(request);

        const { domain, validationToken, credentialId } = body;

        if (!domain || !validationToken || !credentialId) {
          return Response.json(
            {
              ok: false,
              error:
                "domain, validationToken, and credentialId are required",
            },
            { status: 400 }
          );
        }

        const result = await createDnsChallenge(
          domain,
          validationToken,
          Number(credentialId)
        );

        return Response.json({
          ok: true,
          recordId: result.recordId,
          zoneId: result.zoneId,
        });
      }

      /**
       * Remove an ACME DNS-01 challenge TXT record.
       *
       * Body: { action: "cleanup-challenge", zoneId: string, recordId: string, credentialId: number }
       *
       * Used by the certbot hook script and can also be called manually.
       */
      case "cleanup-challenge": {
        await requireAdminOrHookKey(request);

        const { zoneId, recordId, credentialId } = body;

        if (!zoneId || !recordId || !credentialId) {
          return Response.json(
            {
              ok: false,
              error: "zoneId, recordId, and credentialId are required",
            },
            { status: 400 }
          );
        }

        await removeDnsChallenge(
          zoneId,
          recordId,
          Number(credentialId)
        );

        return Response.json({ ok: true });
      }

      /**
       * Check DNS propagation status for an ACME challenge.
       *
       * Body: { action: "check-propagation", domain: string, expectedToken: string, timeoutMs?: number }
       */
      case "check-propagation": {
        await requireAdmin(request);

        const { domain, expectedToken, timeoutMs } = body;

        if (!domain || !expectedToken) {
          return Response.json(
            {
              ok: false,
              error: "domain and expectedToken are required",
            },
            { status: 400 }
          );
        }

        const propagated = await waitForPropagation(
          domain,
          expectedToken,
          timeoutMs
        );

        return Response.json({ ok: true, propagated });
      }

      default:
        return Response.json(
          { ok: false, error: `Unknown action: ${act}` },
          { status: 400 }
        );
    }
  } catch (err: any) {
    return Response.json(
      { ok: false, error: err.message || "An error occurred" },
      { status: 500 }
    );
  }
}
