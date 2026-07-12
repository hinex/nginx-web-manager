import { eq } from "drizzle-orm";
import { db } from "~/lib/db/connection";
import { users } from "~/lib/db/schema";
import { getSessionUser } from "./session.server";
import { checkIpWhitelist, getClientIp } from "./middleware";
import { checkRateLimit, recordFailedAttempt } from "./rate-limit";
import { verifyApiToken } from "./tokens";
import { intersectScopes, ROLE_CEILINGS, type Role, type Scope } from "./scopes";

interface AuthContextBase {
  userId: number;
  role: Role;
  scopes: Scope[];
}

export type AuthContext =
  | (AuthContextBase & { via: "session"; tokenId?: undefined })
  | (AuthContextBase & { via: "token"; tokenId: number });

/**
 * Single auth entry point for API/MCP consumers.
 * Bearer token → scopes ∩ current role ceiling; session → full role ceiling.
 * Throws Response: 401 (invalid/missing auth), 429 (rate limited), 403 (IP whitelist).
 */
export async function authenticate(request: Request): Promise<AuthContext> {
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
