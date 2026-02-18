import { verifyChallengeToken } from "~/lib/auth/challenge";
import { verifyAuthentication } from "~/lib/auth/webauthn";
import { pendingWebAuthnChallenges } from "~/routes/api/webauthn-challenge";
import { db } from "~/lib/db/connection";
import { users, userWebauthnCredentials } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { createToken } from "~/lib/auth/jwt.server";
import { createSessionCookie } from "~/lib/auth/session.server";
import { logAudit } from "~/lib/audit/log";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

export async function action({ request }: { request: Request }) {
  const { challengeToken, response } = (await request.json()) as {
    challengeToken: string;
    response: AuthenticationResponseJSON;
  };

  const challenge = await verifyChallengeToken(challengeToken);
  if (!challenge) {
    return Response.json({ error: "Challenge expired" }, { status: 401 });
  }

  const userKey = String(challenge.userId);
  const expectedChallenge = pendingWebAuthnChallenges.get(userKey);
  if (!expectedChallenge) {
    return Response.json(
      { error: "No pending challenge found. Please try again." },
      { status: 400 }
    );
  }

  // Clean up the stored challenge
  pendingWebAuthnChallenges.delete(userKey);

  // Find the credential being used
  const credential = db
    .select()
    .from(userWebauthnCredentials)
    .where(eq(userWebauthnCredentials.credentialId, response.id))
    .get();

  if (!credential || credential.userId !== challenge.userId) {
    return Response.json(
      { error: "Credential not found" },
      { status: 401 }
    );
  }

  try {
    const verification = await verifyAuthentication(
      response,
      expectedChallenge,
      {
        credentialId: credential.credentialId,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ?? undefined,
      },
      request,
    );

    if (!verification.verified) {
      return Response.json(
        { error: "Verification failed" },
        { status: 401 }
      );
    }

    // Update credential counter to prevent replay attacks
    if (verification.authenticationInfo) {
      db.update(userWebauthnCredentials)
        .set({ counter: verification.authenticationInfo.newCounter })
        .where(eq(userWebauthnCredentials.id, credential.id))
        .run();
    }

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
      details: {
        email: user.email,
        method: "webauthn",
        credentialId: credential.credentialId,
      },
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
  } catch {
    return Response.json(
      { error: "WebAuthn verification failed" },
      { status: 401 }
    );
  }
}
