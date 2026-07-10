import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHash = vi.fn();
if (typeof Bun !== "undefined") {
  // Under the Bun runtime the `Bun` global is non-configurable, so stubGlobal throws
  vi.spyOn(Bun.password, "hash").mockImplementation(mockHash as never);
} else {
  vi.stubGlobal("Bun", { password: { hash: mockHash } });
}

import { hashBasicAuthPasswords } from "./hash-basic-auth";

describe("hashBasicAuthPasswords", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHash.mockImplementation(
      async (password: string) => `$2b$10$mocked_${password}`
    );
  });

  it("returns null basicAuth when input is null", async () => {
    const result = await hashBasicAuthPasswords(null, []);
    expect(result.basicAuth).toBeNull();
    expect(result.locations).toEqual([]);
    expect(mockHash).not.toHaveBeenCalled();
  });

  it("hashes plaintext passwords via Bun.password.hash", async () => {
    const result = await hashBasicAuthPasswords(
      { enabled: true, users: [{ username: "admin", password: "secret123" }] },
      []
    );
    expect(mockHash).toHaveBeenCalledWith("secret123", {
      algorithm: "bcrypt",
      cost: 10,
    });
    expect(result.basicAuth).toEqual({
      enabled: true,
      users: [{ username: "admin", password: "$2b$10$mocked_secret123" }],
    });
  });

  it("skips already-hashed passwords (starting with $2)", async () => {
    const existingHash = "$2b$10$existinghashvalue";
    const result = await hashBasicAuthPasswords(
      { enabled: true, users: [{ username: "admin", password: existingHash }] },
      []
    );
    expect(mockHash).not.toHaveBeenCalled();
    expect(result.basicAuth!.users[0].password).toBe(existingHash);
  });

  it("preserves existing password when edit sends empty password", async () => {
    const existingHash = "$2b$10$existing";
    const result = await hashBasicAuthPasswords(
      { enabled: true, users: [{ username: "admin", password: "" }] },
      [],
      { enabled: true, users: [{ username: "admin", password: existingHash }] }
    );
    expect(mockHash).not.toHaveBeenCalled();
    expect(result.basicAuth!.users[0].password).toBe(existingHash);
  });

  it("filters out users with empty username or password", async () => {
    const result = await hashBasicAuthPasswords(
      {
        enabled: true,
        users: [
          { username: "", password: "pass" },
          { username: "admin", password: "" },
          { username: "valid", password: "test" },
        ],
      },
      []
    );
    expect(result.basicAuth!.users).toEqual([
      { username: "valid", password: "$2b$10$mocked_test" },
    ]);
  });

  it("hashes location-level plaintext passwords", async () => {
    const result = await hashBasicAuthPasswords(null, [
      {
        basicAuth: {
          enabled: true,
          users: [{ username: "locuser", password: "locpass" }],
        },
      },
    ]);
    expect(mockHash).toHaveBeenCalledWith("locpass", {
      algorithm: "bcrypt",
      cost: 10,
    });
    expect(result.locations[0].basicAuth).toEqual({
      enabled: true,
      users: [{ username: "locuser", password: "$2b$10$mocked_locpass" }],
    });
  });

  it("passes through location with basicAuth enabled:false unchanged", async () => {
    const loc = { path: "/api", basicAuth: { enabled: false as const } };
    const result = await hashBasicAuthPasswords(null, [loc]);
    expect(mockHash).not.toHaveBeenCalled();
    expect(result.locations[0]).toBe(loc);
  });

  it("passes through location with null basicAuth unchanged", async () => {
    const loc = { path: "/", basicAuth: null };
    const result = await hashBasicAuthPasswords(null, [loc]);
    expect(mockHash).not.toHaveBeenCalled();
    expect(result.locations[0]).toBe(loc);
  });
});
