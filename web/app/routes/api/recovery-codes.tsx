import { requireAuth } from "~/lib/auth/middleware";
import { db } from "~/lib/db/connection";
import { userRecoveryCodes } from "~/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { logAudit } from "~/lib/audit/log";

/**
 * Generate a random 8-character alphanumeric code.
 */
function generateCode(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

export async function action({ request }: { request: Request }) {
  const user = await requireAuth(request);
  const body = await request.json();
  const { action: actionType } = body as { action: string };
  const ipAddress =
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    "unknown";

  if (actionType === "generate") {
    // Generate 10 random codes
    const plaintextCodes: string[] = [];
    for (let i = 0; i < 10; i++) {
      plaintextCodes.push(generateCode());
    }

    // Hash codes with bcrypt via Bun.password
    const hashedCodes = await Promise.all(
      plaintextCodes.map((code) => Bun.password.hash(code, "bcrypt"))
    );

    // Delete existing recovery codes for this user
    db.delete(userRecoveryCodes)
      .where(eq(userRecoveryCodes.userId, user.userId))
      .run();

    // Store hashed codes
    for (const hashed of hashedCodes) {
      db.insert(userRecoveryCodes)
        .values({
          userId: user.userId,
          code: hashed,
          used: false,
        })
        .run();
    }

    logAudit({
      userId: user.userId,
      action: "update",
      entity: "recovery_codes",
      details: { action: "regenerated", count: 10 },
      ipAddress,
    });

    // Return plaintext codes (shown once to user)
    return Response.json({ codes: plaintextCodes });
  }

  if (actionType === "list") {
    const codes = db
      .select()
      .from(userRecoveryCodes)
      .where(
        and(
          eq(userRecoveryCodes.userId, user.userId),
          eq(userRecoveryCodes.used, false)
        )
      )
      .all();

    return Response.json({ remaining: codes.length });
  }

  return Response.json({ error: "Invalid action" }, { status: 400 });
}
