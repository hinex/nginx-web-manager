import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { eq, desc } from "drizzle-orm";
import { db } from "~/lib/db/connection";
import { apiTokens } from "~/lib/db/schema";
import { isScope, ROLE_CEILINGS, type Role, type Scope } from "./scopes";

export const TOKEN_PREFIX = "ngm_";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateTokenSecret(): { token: string; tokenHash: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export interface CreateTokenInput {
  userId: number;
  role: string;
  name: string;
  scopes: string[];
  expiresInDays: 7 | 30 | 90 | null;
}

export function createApiToken(input: CreateTokenInput) {
  const name = input.name?.trim();
  if (!name) throw new Error("Token name is required");
  if (!input.scopes?.length) throw new Error("At least one scope is required");
  for (const s of input.scopes) {
    if (!isScope(s)) throw new Error(`Unknown scope: ${s}`);
  }
  const ceiling = ROLE_CEILINGS[input.role as Role] ?? [];
  for (const s of input.scopes) {
    if (!ceiling.includes(s as Scope)) {
      throw new Error(`Scope ${s} exceeds role ceiling for role "${input.role}"`);
    }
  }
  const { token, tokenHash } = generateTokenSecret();
  const expiresAt = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
    : null;
  const record = db
    .insert(apiTokens)
    .values({ userId: input.userId, name, tokenHash, scopes: input.scopes, expiresAt })
    .returning()
    .get();
  return { token, record };
}

export type VerifyTokenResult =
  | { ok: true; tokenId: number; userId: number; scopes: string[] }
  | { ok: false; reason: "malformed" | "unknown" | "revoked" | "expired" };

export function verifyApiToken(token: string): VerifyTokenResult {
  if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, reason: "malformed" };
  const tokenHash = hashToken(token);
  const row = db.select().from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash)).get();
  if (!row) return { ok: false, reason: "unknown" };
  // Defense in depth: constant-time re-check of the matched hash.
  const a = Buffer.from(tokenHash, "hex");
  const b = Buffer.from(row.tokenHash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "unknown" };
  }
  if (row.revokedAt) return { ok: false, reason: "revoked" };
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id)).run();
  return { ok: true, tokenId: row.id, userId: row.userId, scopes: (row.scopes as string[]) ?? [] };
}

export function listApiTokens(userId: number) {
  return db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      scopes: apiTokens.scopes,
      expiresAt: apiTokens.expiresAt,
      lastUsedAt: apiTokens.lastUsedAt,
      revokedAt: apiTokens.revokedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt))
    .all();
}

export function revokeApiToken(tokenId: number, userId: number): boolean {
  const row = db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get();
  if (!row || row.userId !== userId || row.revokedAt) return false;
  db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId)).run();
  return true;
}
