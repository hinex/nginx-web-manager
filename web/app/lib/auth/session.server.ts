import { verifyToken, type TokenPayload } from "./jwt.server";

const COOKIE_NAME = "nm_session";
// __Host- prefix (HTTPS only): browser enforces Secure, Path=/ and no Domain,
// so the cookie cannot be overwritten by subdomains or set over plain HTTP.
const SECURE_COOKIE_NAME = "__Host-nm_session";

function isSecureRequest(request?: Request): boolean {
  if (!request) return false;
  return (
    request.url.startsWith("https") ||
    request.headers.get("x-forwarded-proto") === "https"
  );
}

export function createSessionCookie(token: string, request?: Request): string {
  const isSecure = isSecureRequest(request);
  const name = isSecure ? SECURE_COOKIE_NAME : COOKIE_NAME;
  return [
    `${name}=${token}`,
    "HttpOnly",
    isSecure ? "Secure" : "",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=86400",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0`;
}

/** Clears both the plain and __Host- variants of the session cookie. */
export function clearSessionCookies(): string[] {
  return [
    clearSessionCookie(),
    `${SECURE_COOKIE_NAME}=; HttpOnly; Secure; Path=/; Max-Age=0`,
  ];
}

export async function getSessionUser(
  request: Request
): Promise<TokenPayload | null> {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const name of [SECURE_COOKIE_NAME, COOKIE_NAME]) {
    const match = cookieHeader.match(
      new RegExp(`(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]+)`)
    );
    if (match) return verifyToken(match[1]);
  }
  return null;
}

export function requireRole(
  user: TokenPayload | null,
  ...roles: string[]
): TokenPayload {
  if (!user || !roles.includes(user.role)) {
    throw new Response("Forbidden", { status: 403 });
  }
  return user;
}
