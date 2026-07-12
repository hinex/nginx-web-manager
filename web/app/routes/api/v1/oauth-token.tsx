/**
 * POST /api/v1/oauth/token
 *
 * RFC 6749 §4.4 client_credentials grant.
 * Credentials: client_id = "ngm-{api_tokens.id}", client_secret = raw ngm_… token.
 * Issues a short-lived JWT (15 min) bearing sub/tid/scp/typ claims.
 *
 * All responses carry Cache-Control: no-store (RFC 6749 §5.1).
 */

import { eq } from "drizzle-orm";
import { db } from "~/lib/db/connection";
import { apiTokens, users } from "~/lib/db/schema";
import { checkIpWhitelist, getClientIp } from "~/lib/auth/middleware";
import { checkRateLimit, recordFailedAttempt } from "~/lib/auth/rate-limit";
import { verifyApiToken } from "~/lib/auth/tokens";
import { createOAuthToken, OAUTH_JWT_TTL_S } from "~/lib/auth/jwt.server";
import { intersectScopes, type Scope } from "~/lib/auth/scopes";

const NO_STORE = "no-store";

function oauthError(code: string, status: number): Response {
  return Response.json(
    { error: code },
    { status, headers: { "Cache-Control": NO_STORE } }
  );
}

export async function loader({ request }: { request: Request }): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: "POST", "Cache-Control": NO_STORE } }
    );
  }
  return action({ request });
}

export async function action({ request }: { request: Request }): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: "POST", "Cache-Control": NO_STORE } }
    );
  }

  // ── Rate-limit + IP whitelist (same as authenticate()) ───────────────────
  try {
    await checkIpWhitelist(request);
  } catch {
    return Response.json(
      { error: "access_denied" },
      { status: 403, headers: { "Cache-Control": NO_STORE } }
    );
  }

  const ip = getClientIp(request);
  const rate = checkRateLimit(ip);
  if (!rate.allowed) {
    return Response.json(
      { error: "too_many_requests" },
      { status: 429, headers: { "Cache-Control": NO_STORE } }
    );
  }

  // ── Content-Type guard ────────────────────────────────────────────────────
  const ct = request.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return oauthError("unsupported_media_type", 415);
  }

  // ── Parse form body ───────────────────────────────────────────────────────
  let form: URLSearchParams;
  try {
    const text = await request.text();
    form = new URLSearchParams(text);
  } catch {
    return oauthError("invalid_request", 400);
  }

  const grantType = form.get("grant_type");
  if (grantType !== "client_credentials") {
    return oauthError("unsupported_grant_type", 400);
  }

  // ── Client authentication ─────────────────────────────────────────────────
  const clientId = form.get("client_id") ?? "";
  const clientSecret = form.get("client_secret") ?? "";

  const clientIdMatch = /^ngm-(\d+)$/.exec(clientId);
  if (!clientIdMatch) {
    recordFailedAttempt(ip);
    return oauthError("invalid_client", 401);
  }
  const tokenIdFromClientId = parseInt(clientIdMatch[1], 10);

  const verifyResult = verifyApiToken(clientSecret);
  if (!verifyResult.ok || verifyResult.tokenId !== tokenIdFromClientId) {
    recordFailedAttempt(ip);
    return oauthError("invalid_client", 401);
  }

  // ── Load the token row (already validated by verifyApiToken, but we need the row) ──
  const tokenRow = db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.id, verifyResult.tokenId))
    .get();

  if (!tokenRow) {
    // Shouldn't happen if verifyApiToken passed, but be defensive
    recordFailedAttempt(ip);
    return oauthError("invalid_client", 401);
  }

  // ── Load user ─────────────────────────────────────────────────────────────
  const user = db.select().from(users).where(eq(users.id, tokenRow.userId)).get();
  if (!user) {
    recordFailedAttempt(ip);
    return oauthError("invalid_client", 401);
  }

  // ── Compute effective scopes ──────────────────────────────────────────────
  const effective: Scope[] = intersectScopes(tokenRow.scopes as string[], user.role);

  // ── Requested scope narrowing ─────────────────────────────────────────────
  const scopeParam = form.get("scope");
  let granted: Scope[];
  if (scopeParam) {
    const requested = scopeParam.trim().split(/\s+/).filter(Boolean);
    // Every requested scope must be in effective
    const invalid = requested.find((s) => !effective.includes(s as Scope));
    if (invalid) {
      return oauthError("invalid_scope", 400);
    }
    granted = effective.filter((s) => requested.includes(s));
  } else {
    granted = effective;
  }

  // ── Issue JWT ─────────────────────────────────────────────────────────────
  const accessToken = await createOAuthToken({
    userId: user.id,
    tokenId: tokenRow.id,
    scopes: granted,
  });

  return Response.json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: OAUTH_JWT_TTL_S,
      scope: granted.join(" "),
    },
    { status: 200, headers: { "Cache-Control": NO_STORE } }
  );
}
