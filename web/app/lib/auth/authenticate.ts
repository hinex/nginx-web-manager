import { eq } from "drizzle-orm";
import { db } from "~/lib/db/connection";
import { apiTokens, users } from "~/lib/db/schema";
import { getSessionUser } from "./session.server";
import { checkIpWhitelist, checkMtls, getClientIp } from "./middleware";
import { checkRateLimit, recordFailedAttempt } from "./rate-limit";
import { verifyApiToken } from "./tokens";
import { verifyOAuthToken } from "./jwt.server";
import { intersectScopes, ROLE_CEILINGS, type Role, type Scope } from "./scopes";

interface AuthContextBase {
  userId: number;
  role: Role;
  scopes: Scope[];
}

export type AuthContext =
  | (AuthContextBase & { via: "session"; tokenId?: undefined })
  | (AuthContextBase & { via: "token"; tokenId: number });

/** Regex matching a compact JWT (three base64url segments). */
const JWT_BEARER_RE = /^ey[\w-]+\.[\w-]+\.[\w-]+$/;

/**
 * Single auth entry point for API/MCP consumers.
 * Bearer token → scopes ∩ current role ceiling; session → full role ceiling.
 * Throws Response: 401 (invalid/missing auth), 429 (rate limited), 403 (IP whitelist).
 *
 * Bearer dispatch order:
 *   1. ngm_… prefix → opaque token (verifyApiToken)
 *   2. ey…  JWT format → OAuth token (verifyOAuthToken + liveness re-check)
 */
export async function authenticate(request: Request): Promise<AuthContext> {
  await checkMtls(request);
  await checkIpWhitelist(request);

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

  if (bearer) {
    const ip = getClientIp(request);
    const rate = checkRateLimit(ip);
    if (!rate.allowed) {
      throw Response.json(
        { error: "Too many failed attempts, try again later" },
        { status: 429 }
      );
    }

    // ── Branch 1: opaque ngm_ token ───────────────────────────────────────
    if (bearer.startsWith("ngm_")) {
      const result = verifyApiToken(bearer);
      if (!result.ok) {
        recordFailedAttempt(ip);
        throw Response.json({ error: `Invalid token (${result.reason})` }, { status: 401 });
      }
      const user = db.select().from(users).where(eq(users.id, result.userId)).get();
      if (!user) {
        recordFailedAttempt(ip);
        throw Response.json({ error: "Token user no longer exists" }, { status: 401 });
      }
      return {
        userId: user.id,
        role: user.role as Role,
        via: "token",
        tokenId: result.tokenId,
        scopes: intersectScopes(result.scopes, user.role),
      };
    }

    // ── Branch 2: OAuth2 JWT bearer ───────────────────────────────────────
    if (JWT_BEARER_RE.test(bearer)) {
      const payload = await verifyOAuthToken(bearer);
      if (!payload) {
        recordFailedAttempt(ip);
        throw Response.json({ error: "Invalid or expired JWT" }, { status: 401 });
      }

      // Liveness re-check: ensure the backing api_tokens row still exists and is valid
      const tokenRow = db
        .select()
        .from(apiTokens)
        .where(eq(apiTokens.id, payload.tid))
        .get();

      if (
        !tokenRow ||
        tokenRow.revokedAt ||
        (tokenRow.expiresAt && tokenRow.expiresAt.getTime() < Date.now())
      ) {
        recordFailedAttempt(ip);
        throw Response.json({ error: "Token has been revoked or expired" }, { status: 401 });
      }

      const user = db.select().from(users).where(eq(users.id, tokenRow.userId)).get();
      if (!user) {
        recordFailedAttempt(ip);
        throw Response.json({ error: "Token user no longer exists" }, { status: 401 });
      }

      // Effective scopes = JWT-granted scp ∩ current role ceiling
      // (handles role downgrade after token issuance)
      const effective = intersectScopes(
        payload.scp.filter((s) =>
          (tokenRow.scopes as string[]).includes(s)
        ),
        user.role
      );

      return {
        userId: user.id,
        role: user.role as Role,
        via: "token",
        tokenId: tokenRow.id,
        scopes: effective,
      };
    }

    // Unknown bearer format
    recordFailedAttempt(ip);
    throw Response.json({ error: "Invalid token (malformed)" }, { status: 401 });
  }

  const sessionUser = await getSessionUser(request);
  if (!sessionUser) {
    throw Response.json({ error: "Authentication required" }, { status: 401 });
  }
  return {
    userId: sessionUser.userId,
    role: sessionUser.role as Role,
    via: "session",
    scopes: ROLE_CEILINGS[sessionUser.role as Role] ?? [],
  };
}
