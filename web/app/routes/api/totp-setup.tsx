import { requireAuth } from "~/lib/auth/middleware";
import { generateTotpSecret, verifyTotpCode } from "~/lib/auth/totp";
import { db } from "~/lib/db/connection";
import { userTotpSecrets, users } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { logAudit } from "~/lib/audit/log";
import QRCode from "qrcode";

export async function action({ request }: { request: Request }) {
  const user = await requireAuth(request);
  const body = await request.json();
  const { action: actionType, code } = body as {
    action: string;
    code?: string;
  };
  const ipAddress =
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    "unknown";

  if (actionType === "generate") {
    // Check if user already has a verified TOTP secret
    const existing = db
      .select()
      .from(userTotpSecrets)
      .where(eq(userTotpSecrets.userId, user.userId))
      .get();

    if (existing?.verified) {
      return Response.json(
        { error: "TOTP is already enabled. Disable it first." },
        { status: 400 }
      );
    }

    // Get user email for the TOTP URI
    const dbUser = db
      .select()
      .from(users)
      .where(eq(users.id, user.userId))
      .get();

    if (!dbUser) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }

    const { secret, uri } = generateTotpSecret(dbUser.email);
    const qrCode = await QRCode.toDataURL(uri);

    // Remove any existing unverified secret, then insert fresh
    if (existing) {
      db.delete(userTotpSecrets)
        .where(eq(userTotpSecrets.userId, user.userId))
        .run();
    }

    db.insert(userTotpSecrets)
      .values({
        userId: user.userId,
        secret,
        verified: false,
      })
      .run();

    return Response.json({ secret, uri, qrCode });
  }

  if (actionType === "enable") {
    if (!code || typeof code !== "string") {
      return Response.json(
        { error: "Verification code is required" },
        { status: 400 }
      );
    }

    const existing = db
      .select()
      .from(userTotpSecrets)
      .where(eq(userTotpSecrets.userId, user.userId))
      .get();

    if (!existing) {
      return Response.json(
        { error: "No pending TOTP secret. Generate one first." },
        { status: 400 }
      );
    }

    if (existing.verified) {
      return Response.json(
        { error: "TOTP is already enabled" },
        { status: 400 }
      );
    }

    const valid = verifyTotpCode(existing.secret, code);
    if (!valid) {
      return Response.json(
        { error: "Invalid verification code" },
        { status: 401 }
      );
    }

    db.update(userTotpSecrets)
      .set({ verified: true })
      .where(eq(userTotpSecrets.userId, user.userId))
      .run();

    logAudit({
      userId: user.userId,
      action: "update",
      entity: "totp",
      details: { action: "enabled" },
      ipAddress,
    });

    return Response.json({ success: true });
  }

  if (actionType === "disable") {
    const existing = db
      .select()
      .from(userTotpSecrets)
      .where(eq(userTotpSecrets.userId, user.userId))
      .get();

    if (!existing) {
      return Response.json(
        { error: "TOTP is not enabled" },
        { status: 400 }
      );
    }

    db.delete(userTotpSecrets)
      .where(eq(userTotpSecrets.userId, user.userId))
      .run();

    logAudit({
      userId: user.userId,
      action: "update",
      entity: "totp",
      details: { action: "disabled" },
      ipAddress,
    });

    return Response.json({ success: true });
  }

  return Response.json({ error: "Invalid action" }, { status: 400 });
}
