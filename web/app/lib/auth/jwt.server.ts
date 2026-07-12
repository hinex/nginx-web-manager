import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 16) {
    return new TextEncoder().encode(secret);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "JWT_SECRET environment variable must be set to at least 16 characters in production"
    );
  }
  return new TextEncoder().encode("nginx-manager-dev-secret-not-for-production");
}

const JWT_SECRET = getJwtSecret();

export interface TokenPayload extends JWTPayload {
  userId: number;
  email: string;
  role: string;
}

export async function createToken(payload: {
  userId: number;
  email: string;
  role: string;
}): Promise<string> {
  return new SignJWT({
    userId: payload.userId,
    email: payload.email,
    role: payload.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(JWT_SECRET);
}

export async function verifyToken(
  token: string
): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as TokenPayload;
  } catch {
    return null;
  }
}

/** OAuth2 client_credentials JWT — TTL 15 min */
export interface OAuthTokenPayload extends JWTPayload {
  /** subject = userId (string per JWT spec, we store as number) */
  sub: string;
  /** api_tokens.id */
  tid: number;
  /** granted scopes */
  scp: string[];
  /** discriminator so session JWTs can't be used as bearer */
  typ: "oauth";
}

export const OAUTH_JWT_TTL_S = 900; // 15 minutes

export async function createOAuthToken(payload: {
  userId: number;
  tokenId: number;
  scopes: string[];
}): Promise<string> {
  return new SignJWT({
    sub: String(payload.userId),
    tid: payload.tokenId,
    scp: payload.scopes,
    typ: "oauth" as const,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${OAUTH_JWT_TTL_S}s`)
    .sign(JWT_SECRET);
}

export async function verifyOAuthToken(
  token: string
): Promise<OAuthTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    const p = payload as OAuthTokenPayload;
    // Must have typ === "oauth" — reject session JWTs
    if (p.typ !== "oauth") return null;
    return p;
  } catch {
    return null;
  }
}
