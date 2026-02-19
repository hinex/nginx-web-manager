interface BasicAuthData {
  enabled: boolean;
  users: Array<{ username: string; password: string }>;
}

interface LocationWithAuth {
  basicAuth?: BasicAuthData | { enabled: false } | null;
  [key: string]: any;
}

/**
 * Hash plaintext passwords in basicAuth fields for host and locations.
 * Passwords that are already bcrypt-hashed (start with "$2") are left as-is.
 */
export async function hashBasicAuthPasswords(
  basicAuth: BasicAuthData | null | undefined,
  locations: LocationWithAuth[],
  existingBasicAuth?: BasicAuthData | null,
  existingLocations?: LocationWithAuth[]
): Promise<{
  basicAuth: BasicAuthData | null;
  locations: LocationWithAuth[];
}> {
  // Hash host-level passwords
  let hashedHostAuth: BasicAuthData | null = basicAuth ?? null;
  if (basicAuth?.enabled && basicAuth.users.length > 0) {
    const hashedUsers = await Promise.all(
      basicAuth.users.map(async (user) => {
        if (!user.password) {
          // Empty password on edit = keep existing
          const existing = existingBasicAuth?.enabled
            ? (existingBasicAuth as BasicAuthData).users.find((u) => u.username === user.username)
            : undefined;
          return { username: user.username, password: existing?.password ?? "" };
        }
        if (user.password.startsWith("$2")) return user; // already hashed
        return {
          username: user.username,
          password: await Bun.password.hash(user.password, { algorithm: "bcrypt", cost: 10 }),
        };
      })
    );
    hashedHostAuth = { enabled: true, users: hashedUsers.filter((u) => u.username && u.password) };
  }

  // Hash location-level passwords
  const hashedLocations = await Promise.all(
    locations.map(async (loc, i) => {
      if (!loc.basicAuth || !("enabled" in loc.basicAuth) || !loc.basicAuth.enabled) {
        return loc;
      }
      const auth = loc.basicAuth as BasicAuthData;
      const existingLocAuth = existingLocations?.[i]?.basicAuth;
      const hashedUsers = await Promise.all(
        auth.users.map(async (user) => {
          if (!user.password) {
            const existing =
              existingLocAuth && "enabled" in existingLocAuth && existingLocAuth.enabled
                ? (existingLocAuth as BasicAuthData).users.find((u) => u.username === user.username)
                : undefined;
            return { username: user.username, password: existing?.password ?? "" };
          }
          if (user.password.startsWith("$2")) return user;
          return {
            username: user.username,
            password: await Bun.password.hash(user.password, { algorithm: "bcrypt", cost: 10 }),
          };
        })
      );
      return { ...loc, basicAuth: { enabled: true as const, users: hashedUsers.filter((u) => u.username && u.password) } };
    })
  );

  return { basicAuth: hashedHostAuth, locations: hashedLocations };
}
