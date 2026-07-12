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
  if (user.role === "admin") {
    const row = db
      .select()
      .from(settings)
      .where(eq(settings.key, "mcp_path_secret"))
      .get();
    mcpPathSecret = row?.value || null;
  }
  return Response.json({ tokens, mcpPathSecret });
}

export async function action({ request }: { request: Request }) {
  const user = await requireAuth(request);
  const body = await request.json();

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

    default:
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
}
