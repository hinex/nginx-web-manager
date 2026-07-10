import { verifyChallengeToken } from "~/lib/auth/challenge";
import { verifyTotpCodeOnce } from "~/lib/auth/totp";
import {
  checkRateLimit,
  recordFailedAttempt,
  resetAttempts,
} from "~/lib/auth/rate-limit";
import { db } from "~/lib/db/connection";
import { users, userTotpSecrets } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { createToken } from "~/lib/auth/jwt.server";
import { createSessionCookie } from "~/lib/auth/session.server";
import { logAudit } from "~/lib/audit/log";

export async function action({ request }: { request: Request }) {
  const ip =
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    "unknown";

  const rateLimit = checkRateLimit(ip);
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Too many attempts. Try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            Math.ceil((rateLimit.retryAfterMs ?? 60000) / 1000)
          ),
        },
      }
    );
  }

  const { challengeToken, code } = await request.json();

  const challenge = await verifyChallengeToken(challengeToken);
  if (!challenge) {
    return Response.json({ error: "Challenge expired" }, { status: 401 });
  }

  const totp = db
    .select()
    .from(userTotpSecrets)
    .where(eq(userTotpSecrets.userId, challenge.userId))
    .get();

  if (!totp || !totp.verified) {
    return Response.json({ error: "TOTP not configured" }, { status: 400 });
  }

  const valid = verifyTotpCodeOnce(challenge.userId, totp.secret, code);
  if (!valid) {
    recordFailedAttempt(ip);
    return Response.json({ error: "Invalid code" }, { status: 401 });
  }

  resetAttempts(ip);

  const user = db
    .select()
    .from(users)
    .where(eq(users.id, challenge.userId))
    .get();

  if (!user) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  const token = await createToken({
    userId: user.id,
    email: user.email,
    role: user.role,
  });

  logAudit({
    userId: user.id,
    action: "login",
    entity: "user",
    entityId: user.id,
    details: { email: user.email, method: "totp" },
    ipAddress:
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      "unknown",
  });

  return Response.json(
    { success: true },
    {
      headers: { "Set-Cookie": createSessionCookie(token, request) },
    }
  );
}
