import { SignJWT, jwtVerify } from "jose";
import { getJwtSecret } from "./jwt.server";

const CHALLENGE_SECRET = getJwtSecret();

export async function createChallengeToken(userId: number): Promise<string> {
  return new SignJWT({ userId, type: "2fa_challenge" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(CHALLENGE_SECRET);
}

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
