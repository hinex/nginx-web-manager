import { verifyChallengeToken } from "~/lib/auth/challenge";
import { getAuthenticationOptions } from "~/lib/auth/webauthn";
import { db } from "~/lib/db/connection";
import { userWebauthnCredentials } from "~/lib/db/schema";
import { eq } from "drizzle-orm";

// In-memory store for pending WebAuthn challenges.
// Maps a string key (userId) to the expected challenge string.
export const pendingWebAuthnChallenges = new Map<string, string>();

export async function action({ request }: { request: Request }) {
  const { challengeToken } = await request.json();

  const challenge = await verifyChallengeToken(challengeToken);
  if (!challenge) {
    return Response.json({ error: "Challenge expired" }, { status: 401 });
  }

  const credentials = db
    .select()
    .from(userWebauthnCredentials)
    .where(eq(userWebauthnCredentials.userId, challenge.userId))
    .all();

  if (credentials.length === 0) {
    return Response.json(
      { error: "No WebAuthn credentials registered" },
      { status: 400 }
    );
  }

  const storedCredentials = credentials.map((c) => ({
    credentialId: c.credentialId,
    publicKey: c.publicKey,
    counter: c.counter,
    transports: c.transports ?? undefined,
  }));

  const options = await getAuthenticationOptions(storedCredentials, request);

  // Store the challenge for verification
  pendingWebAuthnChallenges.set(
    String(challenge.userId),
    options.challenge
  );

  return Response.json(options);
}
