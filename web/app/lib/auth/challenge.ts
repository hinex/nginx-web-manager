import { SignJWT, jwtVerify } from "jose";

const CHALLENGE_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || "nginx-manager-default-secret-change-me!!"
);

/**
 * Create a short-lived challenge JWT (5 min TTL) for 2FA verification.
 * Issued after successful password verification when the user has 2FA enabled.
 */
export async function createChallengeToken(userId: number): Promise<string> {
  return new SignJWT({ userId, type: "2fa_challenge" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(CHALLENGE_SECRET);
}

/**
 * Verify a 2FA challenge token. Returns the userId if valid, null otherwise.
 */
export async function verifyChallengeToken(
  token: string
): Promise<{ userId: number } | null> {
  try {
    const { payload } = await jwtVerify(token, CHALLENGE_SECRET);
    if (payload.type !== "2fa_challenge") return null;
    return { userId: payload.userId as number };
  } catch {
    return null;
  }
}
