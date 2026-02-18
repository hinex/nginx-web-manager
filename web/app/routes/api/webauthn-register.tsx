import { requireAuth } from "~/lib/auth/middleware";
import { getRegistrationOptions, verifyRegistration } from "~/lib/auth/webauthn";
import { db } from "~/lib/db/connection";
import { userWebauthnCredentials, users } from "~/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { logAudit } from "~/lib/audit/log";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

// In-memory store for pending registration challenges.
const pendingRegistrationChallenges = new Map<string, string>();

export async function action({ request }: { request: Request }) {
  const user = await requireAuth(request);
  const body = await request.json();
  const { action: actionType, response, credentialId, deviceName } = body as {
    action: string;
    response?: RegistrationResponseJSON;
    credentialId?: number;
    deviceName?: string;
  };
  const ipAddress =
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    "unknown";

  if (actionType === "options") {
    // Get user details
    const dbUser = db
      .select()
      .from(users)
      .where(eq(users.id, user.userId))
      .get();

    if (!dbUser) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }

    // Get existing credentials
    const existingCredentials = db
      .select()
      .from(userWebauthnCredentials)
      .where(eq(userWebauthnCredentials.userId, user.userId))
      .all()
      .map((c) => ({
        credentialId: c.credentialId,
        publicKey: c.publicKey,
        counter: c.counter,
        transports: c.transports ?? undefined,
      }));

    const options = await getRegistrationOptions(
      String(user.userId),
      dbUser.email,
      existingCredentials,
      request,
    );

    // Store challenge for verification
    pendingRegistrationChallenges.set(String(user.userId), options.challenge);

    return Response.json(options);
  }

  if (actionType === "verify") {
    if (!response) {
      return Response.json(
        { error: "Registration response is required" },
        { status: 400 }
      );
    }

    const expectedChallenge = pendingRegistrationChallenges.get(
      String(user.userId)
    );
    if (!expectedChallenge) {
      return Response.json(
        { error: "No pending registration challenge. Please try again." },
        { status: 400 }
      );
    }

    // Clean up stored challenge
    pendingRegistrationChallenges.delete(String(user.userId));

    try {
      const verification = await verifyRegistration(
        response,
        expectedChallenge,
        request,
      );

      if (!verification.verified || !verification.registrationInfo) {
        return Response.json(
          { error: "Verification failed" },
          { status: 401 }
        );
      }

      const { credential } = verification.registrationInfo;

      // Store credential in DB
      db.insert(userWebauthnCredentials)
        .values({
          userId: user.userId,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          counter: credential.counter,
          deviceName: deviceName || "Passkey",
          transports: response.response.transports ?? null,
        })
        .run();

      logAudit({
        userId: user.userId,
        action: "create",
        entity: "webauthn_credential",
        details: { deviceName: deviceName || "Passkey" },
        ipAddress,
      });

      return Response.json({ success: true });
    } catch {
      return Response.json(
        { error: "WebAuthn registration verification failed" },
        { status: 401 }
      );
    }
  }

  if (actionType === "delete") {
    if (!credentialId || typeof credentialId !== "number") {
      return Response.json(
        { error: "Credential ID is required" },
        { status: 400 }
      );
    }

    const credential = db
      .select()
      .from(userWebauthnCredentials)
      .where(
        and(
          eq(userWebauthnCredentials.id, credentialId),
          eq(userWebauthnCredentials.userId, user.userId)
        )
      )
      .get();

    if (!credential) {
      return Response.json(
        { error: "Credential not found" },
        { status: 404 }
      );
    }

    db.delete(userWebauthnCredentials)
      .where(eq(userWebauthnCredentials.id, credentialId))
      .run();

    logAudit({
      userId: user.userId,
      action: "delete",
      entity: "webauthn_credential",
      entityId: credentialId,
      details: { deviceName: credential.deviceName },
      ipAddress,
    });

    return Response.json({ success: true });
  }

  return Response.json({ error: "Invalid action" }, { status: 400 });
}
