import { verifyToken, type TokenPayload } from "./jwt.server";

const COOKIE_NAME = "nm_session";

export function createSessionCookie(token: string, request?: Request): string {
  const isSecure = request
    ? (request.url.startsWith("https") ||
       request.headers.get("x-forwarded-proto") === "https")
    : false;
  return [
    `${COOKIE_NAME}=${token}`,
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

export async function getSessionUser(
  request: Request
): Promise<TokenPayload | null> {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  return verifyToken(match[1]);
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
