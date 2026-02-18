import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";

const RP_NAME = "Nginx Manager";

/**
 * Get Relying Party configuration.
 * Derives rpId and origin from the request Host header when available,
 * falling back to environment variables or "localhost".
 */
function getRpConfig(request?: Request) {
  if (process.env.WEBAUTHN_RP_ID) {
    const rpId = process.env.WEBAUTHN_RP_ID;
    const origin = process.env.WEBAUTHN_ORIGIN || `https://${rpId}`;
    return { rpId, origin };
  }

  if (request) {
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
    if (host) {
      const hostname = host.split(":")[0];
      const protocol = request.headers.get("x-forwarded-proto") || "http";
      return { rpId: hostname, origin: `${protocol}://${host}` };
    }
  }

  return { rpId: "localhost", origin: "http://localhost" };
}

/**
 * A stored WebAuthn credential as persisted in the database.
 * All binary values are base64url-encoded strings.
 */
export interface StoredCredential {
  credentialId: string; // base64url encoded
  publicKey: string; // base64url encoded
  counter: number;
  transports?: string[];
}

/**
 * Generate registration options for a user.
 * Returns a PublicKeyCredentialCreationOptionsJSON object to be passed
 * to the browser's `startRegistration()` call.
 */
export async function getRegistrationOptions(
  userId: string,
  userName: string,
  existingCredentials: StoredCredential[],
  request?: Request,
) {
  const { rpId } = getRpConfig(request);

  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId,
    userID: new TextEncoder().encode(userId),
    userName,
    attestationType: "none",
    excludeCredentials: existingCredentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
}

/**
 * Verify a registration response returned by the browser after the user
 * completes the WebAuthn registration ceremony.
 */
export async function verifyRegistration(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
  request?: Request,
) {
  const { rpId, origin } = getRpConfig(request);

  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedRPID: rpId,
    expectedOrigin: origin,
  });
}

/**
 * Generate authentication options for a user who wants to sign in with
 * a previously registered credential.
 */
export async function getAuthenticationOptions(
  existingCredentials: StoredCredential[],
  request?: Request,
) {
  const { rpId } = getRpConfig(request);

  return generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: existingCredentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    userVerification: "preferred",
  });
}

/**
 * Verify an authentication response returned by the browser after the user
 * completes the WebAuthn authentication ceremony.
 */
export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  credential: StoredCredential,
  request?: Request,
) {
  const { rpId, origin } = getRpConfig(request);

  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedRPID: rpId,
    expectedOrigin: origin,
    credential: {
      id: credential.credentialId,
      publicKey: new Uint8Array(
        Buffer.from(credential.publicKey, "base64url"),
      ),
      counter: credential.counter,
      transports: credential.transports as
        | AuthenticatorTransportFuture[]
        | undefined,
    },
  });
}
