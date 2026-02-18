import { db } from "./connection";
import { users, settings } from "./schema";
import { eq } from "drizzle-orm";

const DEFAULT_ADMIN_EMAIL = "admin@example.com";
const DEFAULT_ADMIN_PASSWORD = "changeme";

export async function seed() {
  // Only create default admin if no users exist at all
  const anyUser = db.select({ id: users.id }).from(users).get();

  if (!anyUser) {
    const hashedPassword = await Bun.password.hash(DEFAULT_ADMIN_PASSWORD, {
      algorithm: "argon2id",
    });

    db.insert(users).values({
      email: DEFAULT_ADMIN_EMAIL,
      password: hashedPassword,
      name: "Administrator",
      role: "admin",
      mustChangePassword: true,
    }).run();

    console.log(`[seed] Created default admin user: ${DEFAULT_ADMIN_EMAIL}`);
  }

  // Seed default settings — sensible defaults for Docker deployment
  const defaultSettings = [
    { key: "global_webhook_url", value: "" },
    { key: "watchdog_interval_ms", value: "30000" },
    { key: "audit_retention_days", value: "90" },
    { key: "health_retention_days", value: "30" },
    { key: "ip_whitelist", value: "" },
    { key: "max_login_attempts", value: "10" },
    { key: "login_ban_duration_minutes", value: "10" },
    { key: "config_version_retention_days", value: "30" },
  ];

  for (const s of defaultSettings) {
    const existing = db.select().from(settings).where(eq(settings.key, s.key)).get();
    if (!existing) {
      db.insert(settings).values(s).run();
    }
  }

  console.log("[seed] Default settings initialized");
}
