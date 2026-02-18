import type { Route } from "./+types/dns";
import { requireEditor } from "~/lib/auth/middleware";
import { db } from "~/lib/db/connection";
import { dnsCredentials } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { CloudflareDnsProvider } from "~/lib/dns/cloudflare";
import type { DnsProvider } from "~/lib/dns/provider";
import { encrypt, decrypt } from "~/lib/crypto/encrypt";

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
 * Fetches a credential by ID and decrypts the apiToken for use.
 */
function getDecryptedCredential(credentialId: number) {
  const cred = db
    .select()
    .from(dnsCredentials)
    .where(eq(dnsCredentials.id, Number(credentialId)))
    .get();
  if (!cred) return null;
  return { ...cred, apiToken: decrypt(cred.apiToken) };
}

export async function action({ request }: Route.ActionArgs) {
  await requireEditor(request);

  const body = await request.json();
  const { action: act } = body;

  try {
    switch (act) {
      case "list-credentials": {
        const creds = db
          .select({
            id: dnsCredentials.id,
            name: dnsCredentials.name,
            provider: dnsCredentials.provider,
            createdAt: dnsCredentials.createdAt,
          })
          .from(dnsCredentials)
          .all();
        return Response.json({ ok: true, credentials: creds });
      }

      case "add-credential": {
        const { name, provider, apiToken } = body;
        if (!name || !provider || !apiToken) {
          return Response.json(
            { ok: false, error: "Name, provider, and API token are required" },
            { status: 400 }
          );
        }
        if (provider !== "cloudflare") {
          return Response.json(
            { ok: false, error: "Unsupported provider" },
            { status: 400 }
          );
        }
        const encryptedToken = encrypt(apiToken);
        const result = db
          .insert(dnsCredentials)
          .values({
            name,
            provider,
            apiToken: encryptedToken,
            createdAt: new Date(),
          })
          .returning()
          .get();
        return Response.json({
          ok: true,
          credential: {
            id: result.id,
            name: result.name,
            provider: result.provider,
            createdAt: result.createdAt,
          },
        });
      }

      case "delete-credential": {
        const { id } = body;
        if (!id) {
          return Response.json(
            { ok: false, error: "Credential ID is required" },
            { status: 400 }
          );
        }
        db.delete(dnsCredentials)
          .where(eq(dnsCredentials.id, Number(id)))
          .run();
        return Response.json({ ok: true });
      }

      case "list-zones": {
        const { credentialId } = body;
        if (!credentialId) {
          return Response.json(
            { ok: false, error: "Credential ID is required" },
            { status: 400 }
          );
        }
        const cred = getDecryptedCredential(Number(credentialId));
        if (!cred) {
          return Response.json(
            { ok: false, error: "Credential not found" },
            { status: 404 }
          );
        }
        const provider = getProvider(cred);
        const zones = await provider.listZones();
        return Response.json({ ok: true, zones });
      }

      case "list-records": {
        const { credentialId, zoneId } = body;
        if (!credentialId || !zoneId) {
          return Response.json(
            { ok: false, error: "Credential ID and zone ID are required" },
            { status: 400 }
          );
        }
        const cred = getDecryptedCredential(Number(credentialId));
        if (!cred) {
          return Response.json(
            { ok: false, error: "Credential not found" },
            { status: 404 }
          );
        }
        const provider = getProvider(cred);
        const records = await provider.listRecords(zoneId);
        return Response.json({ ok: true, records });
      }

      case "create-record": {
        const { credentialId, zoneId, record } = body;
        if (!credentialId || !zoneId || !record) {
          return Response.json(
            {
              ok: false,
              error: "Credential ID, zone ID, and record are required",
            },
            { status: 400 }
          );
        }
        const cred = getDecryptedCredential(Number(credentialId));
        if (!cred) {
          return Response.json(
            { ok: false, error: "Credential not found" },
            { status: 404 }
          );
        }
        const provider = getProvider(cred);
        const created = await provider.createRecord(zoneId, record);
        return Response.json({ ok: true, record: created });
      }

      case "update-record": {
        const { credentialId, zoneId, recordId, record } = body;
        if (!credentialId || !zoneId || !recordId || !record) {
          return Response.json(
            {
              ok: false,
              error:
                "Credential ID, zone ID, record ID, and record are required",
            },
            { status: 400 }
          );
        }
        const cred = getDecryptedCredential(Number(credentialId));
        if (!cred) {
          return Response.json(
            { ok: false, error: "Credential not found" },
            { status: 404 }
          );
        }
        const provider = getProvider(cred);
        const updated = await provider.updateRecord(zoneId, recordId, record);
        return Response.json({ ok: true, record: updated });
      }

      case "delete-record": {
        const { credentialId, zoneId, recordId } = body;
        if (!credentialId || !zoneId || !recordId) {
          return Response.json(
            {
              ok: false,
              error: "Credential ID, zone ID, and record ID are required",
            },
            { status: 400 }
          );
        }
        const cred = getDecryptedCredential(Number(credentialId));
        if (!cred) {
          return Response.json(
            { ok: false, error: "Credential not found" },
            { status: 404 }
          );
        }
        const provider = getProvider(cred);
        await provider.deleteRecord(zoneId, recordId);
        return Response.json({ ok: true });
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
