import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { requireAuth, requireAdmin } from "~/lib/auth/middleware";
import { createApiToken, listApiTokens, revokeApiToken } from "~/lib/auth/tokens";
import { logAudit } from "~/lib/audit/log";
import { db } from "~/lib/db/connection";
import { settings } from "~/lib/db/schema";

// Token management is deliberately session-only: an API token must never
// be able to create or revoke tokens.

export async function loader({ request }: { request: Request }) {
  const user = await requireAuth(request);
  const tokens = listApiTokens(user.userId);
  let mcpPathSecret: string | null = null;
  let requireMtls = false;
  if (user.role === "admin") {
    const secretRow = db
      .select()
      .from(settings)
      .where(eq(settings.key, "mcp_path_secret"))
      .get();
    mcpPathSecret = secretRow?.value || null;
    const mtlsRow = db
      .select()
      .from(settings)
      .where(eq(settings.key, "require_mtls"))
      .get();
    requireMtls = mtlsRow?.value === "true";
  }
  return Response.json({ tokens, mcpPathSecret, requireMtls });
}

export async function action({ request }: { request: Request }) {
  const user = await requireAuth(request);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  switch (body.action) {
    case "create": {
      const { name, scopes, expiresInDays } = body;
      const expiry = expiresInDays ?? null;
      if (![7, 30, 90, null].includes(expiry)) {
        return Response.json({ error: "expiresInDays must be 7, 30, 90 or null" }, { status: 400 });
      }
      try {
        const { token, record } = createApiToken({
          userId: user.userId,
          role: user.role,
          name,
          scopes,
          expiresInDays: expiry,
        });
        logAudit({
          userId: user.userId,
          action: "create",
          entity: "api_token",
          entityId: record.id,
          details: { name: record.name, scopes },
        });
        return Response.json({
          token, // shown exactly once
          record: {
            id: record.id,
            name: record.name,
            scopes: record.scopes,
            expiresAt: record.expiresAt,
            createdAt: record.createdAt,
          },
        });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }
    }

    case "revoke": {
      const tokenId = Number(body.tokenId);
      if (!Number.isInteger(tokenId)) {
        return Response.json({ error: "tokenId must be an integer" }, { status: 400 });
      }
      if (!revokeApiToken(tokenId, user.userId)) {
        return Response.json({ error: "Token not found" }, { status: 404 });
      }
      logAudit({
        userId: user.userId,
        action: "delete",
        entity: "api_token",
        entityId: tokenId,
      });
      return Response.json({ revoked: true });
    }

    case "set_mcp_secret": {
      await requireAdmin(request);
      const value = body.enabled ? randomBytes(16).toString("base64url") : "";
      const existing = db
        .select()
        .from(settings)
        .where(eq(settings.key, "mcp_path_secret"))
        .get();
      if (existing) {
        db.update(settings).set({ value }).where(eq(settings.key, "mcp_path_secret")).run();
      } else {
        db.insert(settings).values({ key: "mcp_path_secret", value }).run();
      }
      logAudit({
        userId: user.userId,
        action: "update",
        entity: "settings",
        details: { key: "mcp_path_secret", enabled: !!body.enabled },
      });
      return Response.json({ mcpPathSecret: value || null });
    }

    case "set_require_mtls": {
      await requireAdmin(request);
      const value = body.enabled ? "true" : "false";
      const existing = db
        .select()
        .from(settings)
        .where(eq(settings.key, "require_mtls"))
        .get();
      if (existing) {
        db.update(settings).set({ value }).where(eq(settings.key, "require_mtls")).run();
      } else {
        db.insert(settings).values({ key: "require_mtls", value }).run();
      }
      logAudit({
        userId: user.userId,
        action: "update",
        entity: "settings",
        details: { key: "require_mtls", enabled: !!body.enabled },
      });
      return Response.json({ requireMtls: !!body.enabled });
    }

    default:
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
}
