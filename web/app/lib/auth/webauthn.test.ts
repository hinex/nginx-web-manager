import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getRegistrationOptions,
  getAuthenticationOptions,
  verifyRegistration,
  verifyAuthentication,
  type StoredCredential,
} from "./webauthn";

describe("webauthn", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Ensure clean environment for each test
    delete process.env.WEBAUTHN_RP_ID;
    delete process.env.WEBAUTHN_ORIGIN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ─── getRegistrationOptions ──────────────────────────────

  describe("getRegistrationOptions", () => {
    it("returns options with a challenge string", async () => {
      const options = await getRegistrationOptions("user-1", "alice@example.com", []);

      expect(options).toBeDefined();
      expect(typeof options.challenge).toBe("string");
      expect(options.challenge.length).toBeGreaterThan(0);
    });

    it("includes rp name and id in the options", async () => {
      const options = await getRegistrationOptions("user-1", "alice@example.com", []);

      expect(options.rp.name).toBe("Nginx Manager");
      expect(options.rp.id).toBe("localhost");
    });

    it("includes user info in the options", async () => {
      const options = await getRegistrationOptions("user-42", "bob@example.com", []);

      expect(options.user).toBeDefined();
      expect(options.user.name).toBe("bob@example.com");
    });

    it("uses custom rpId from environment", async () => {
      process.env.WEBAUTHN_RP_ID = "myapp.example.com";

      const options = await getRegistrationOptions("user-1", "alice@example.com", []);

      expect(options.rp.id).toBe("myapp.example.com");
    });

    it("excludes existing credentials", async () => {
      const existing: StoredCredential[] = [
        {
          credentialId: "Y3JlZC0x",
          publicKey: "cHVibGljLWtleS0x",
          counter: 0,
          transports: ["usb"],
        },
        {
          credentialId: "Y3JlZC0y",
          publicKey: "cHVibGljLWtleS0y",
          counter: 5,
          transports: ["internal"],
        },
      ];

      const options = await getRegistrationOptions("user-1", "alice@example.com", existing);

      expect(options.excludeCredentials).toBeDefined();
      expect(options.excludeCredentials).toHaveLength(2);
      expect(options.excludeCredentials![0].id).toBe("Y3JlZC0x");
      expect(options.excludeCredentials![1].id).toBe("Y3JlZC0y");
    });

    it("sets authenticator selection preferences", async () => {
      const options = await getRegistrationOptions("user-1", "alice@example.com", []);

      expect(options.authenticatorSelection).toBeDefined();
      expect(options.authenticatorSelection!.residentKey).toBe("preferred");
      expect(options.authenticatorSelection!.userVerification).toBe("preferred");
    });

    it("sets attestation type to none", async () => {
      const options = await getRegistrationOptions("user-1", "alice@example.com", []);

      expect(options.attestation).toBe("none");
    });

    it("generates different challenges on each call", async () => {
      const options1 = await getRegistrationOptions("user-1", "alice@example.com", []);
      const options2 = await getRegistrationOptions("user-1", "alice@example.com", []);

      expect(options1.challenge).not.toBe(options2.challenge);
    });
  });

  // ─── getAuthenticationOptions ────────────────────────────

  describe("getAuthenticationOptions", () => {
    it("returns options with a challenge string", async () => {
      const options = await getAuthenticationOptions([]);

      expect(options).toBeDefined();
      expect(typeof options.challenge).toBe("string");
      expect(options.challenge.length).toBeGreaterThan(0);
    });

    it("includes rpId in the options", async () => {
      const options = await getAuthenticationOptions([]);

      expect(options.rpId).toBe("localhost");
    });

    it("uses custom rpId from environment", async () => {
      process.env.WEBAUTHN_RP_ID = "secure.example.com";

      const options = await getAuthenticationOptions([]);

      expect(options.rpId).toBe("secure.example.com");
    });

    it("includes allowed credentials when provided", async () => {
      const existing: StoredCredential[] = [
        {
          credentialId: "Y3JlZC0x",
          publicKey: "cHVibGljLWtleS0x",
          counter: 3,
          transports: ["usb", "nfc"],
        },
      ];

      const options = await getAuthenticationOptions(existing);

      expect(options.allowCredentials).toBeDefined();
      expect(options.allowCredentials).toHaveLength(1);
      expect(options.allowCredentials![0].id).toBe("Y3JlZC0x");
    });

    it("sets user verification to preferred", async () => {
      const options = await getAuthenticationOptions([]);

      expect(options.userVerification).toBe("preferred");
    });

    it("generates different challenges on each call", async () => {
      const options1 = await getAuthenticationOptions([]);
      const options2 = await getAuthenticationOptions([]);

      expect(options1.challenge).not.toBe(options2.challenge);
    });
  });

  // ─── verifyRegistration ──────────────────────────────────

  describe("verifyRegistration", () => {
    it("is a callable async function", () => {
      expect(typeof verifyRegistration).toBe("function");
    });

    it("rejects with invalid registration response data", async () => {
      // A completely invalid response should throw during verification
      const fakeResponse = {
        id: "fake-id",
        rawId: "fake-raw-id",
        response: {
          clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0",
          attestationObject: "o2NmbXRkbm9uZQ",
        },
        type: "public-key" as const,
        clientExtensionResults: {},
        authenticatorAttachment: "platform" as const,
      };

      await expect(
        verifyRegistration(fakeResponse, "fake-challenge"),
      ).rejects.toThrow();
    });
  });

  // ─── verifyAuthentication ────────────────────────────────

  describe("verifyAuthentication", () => {
    it("is a callable async function", () => {
      expect(typeof verifyAuthentication).toBe("function");
    });

    it("rejects with invalid authentication response data", async () => {
      const fakeResponse = {
        id: "fake-id",
        rawId: "fake-raw-id",
        response: {
          clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0",
          authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2M",
          signature: "MEUCIQDbs0",
        },
        type: "public-key" as const,
        clientExtensionResults: {},
      };

      const fakeCredential: StoredCredential = {
        credentialId: "fake-id",
        publicKey: "cHVibGljLWtleQ",
        counter: 0,
        transports: ["usb"],
      };

      await expect(
        verifyAuthentication(fakeResponse, "fake-challenge", fakeCredential),
      ).rejects.toThrow();
    });
  });
});
