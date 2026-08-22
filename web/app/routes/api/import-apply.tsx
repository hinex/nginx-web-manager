import type { Route } from "./+types/import-apply";
import { requireAdmin } from "~/lib/auth/middleware";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, resolve, sep } from "path";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { reloadNginx } from "~/lib/nginx/reload";
import { logAudit } from "~/lib/audit/log";
import {
  getImport,
  removeImport,
  type ParsedBackup,
} from "~/lib/backup/import-cache";
import { db } from "~/lib/db/connection";
import {
  hosts,
  hostGroups,
  settings,
  accessLists,
  accessListClients,
  accessListAuth,
  customTemplates,
} from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { nginxDir } from "~/lib/paths";


/**
 * Prepare a backup row for insertion: JSON serialization turns Date columns
 * into ISO strings, which drizzle's timestamp_ms mapper cannot store. Original
 * ids are kept — tables are fully cleared before restore, and dropping them
 * would break foreign keys (hosts.groupId, accessListClients.accessListId).
 */
function reviveRow<T>(row: unknown): T {
  const out = { ...(row as Record<string, unknown>) };
  for (const [key, value] of Object.entries(out)) {
    if (key.endsWith("At") && (typeof value === "string" || typeof value === "number")) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) out[key] = date;
    }
  }
  return out as T;
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireAdmin(request);
  const body = await request.json();

  let backup: ParsedBackup;

  if (body.importId) {
    // Retrieve from cache by import ID (new tar.gz flow)
    const cached = getImport(body.importId);
    if (!cached) {
      return Response.json(
        {
          error:
            "Import data expired or not found. Please upload the file again.",
        },
        { status: 400 }
      );
    }
    backup = cached;
  } else if (body.version && body.configs && body.database) {
    // Legacy direct JSON upload
    backup = {
      version: body.version,
      exportedAt: body.exportedAt,
      configs: body.configs,
      database: body.database,
      customTemplates: body.customTemplates,
    };
  } else {
    return Response.json(
      { error: "Invalid request. Provide importId or full backup data." },
      { status: 400 }
    );
  }

  const results = { configsWritten: 0, errors: [] as string[] };

  // Write config files (relative paths are resolved against NGINX_DIR).
  // Resolved paths are validated to stay inside NGINX_DIR so a malicious
  // archive entry (e.g. "../../etc/passwd" or an absolute path) cannot
  // escape the nginx config directory (zip-slip).
  const nginxRoot = nginxDir();
  for (const [relPath, content] of Object.entries(backup.configs)) {
    try {
      const fullPath = resolve(nginxRoot, relPath);
      if (fullPath !== nginxRoot && !fullPath.startsWith(nginxRoot + sep)) {
        results.errors.push(
          `Skipped ${relPath}: path escapes the nginx config directory`
        );
        continue;
      }
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content as string);
      results.configsWritten++;
    } catch (err) {
      results.errors.push(
        `Failed to write ${relPath}: ${(err as Error).message}`
      );
    }
  }

  // Restore database data inside a transaction
  try {
    db.transaction((tx) => {
      const dbData = backup.database ?? {};

      // Settings: upsert each key/value pair
      if (Array.isArray(dbData.settings)) {
        for (const row of dbData.settings as Array<{ key: string; value: string | null }>) {
          const existing = tx
            .select()
            .from(settings)
            .where(eq(settings.key, row.key))
            .get();
          if (existing) {
            tx.update(settings)
              .set({ value: row.value })
              .where(eq(settings.key, row.key))
              .run();
          } else {
            tx.insert(settings).values({ key: row.key, value: row.value }).run();
          }
        }
      }

      // Access lists: clear clients/auth first (foreign key dependencies), then lists
      if (Array.isArray(dbData.accessLists)) {
        tx.delete(accessListClients).run();
        tx.delete(accessListAuth).run();
        tx.delete(accessLists).run();
        for (const row of dbData.accessLists) {
          tx.insert(accessLists).values(reviveRow<typeof accessLists.$inferInsert>(row)).run();
        }
      }

      if (Array.isArray(dbData.accessListClients)) {
        for (const row of dbData.accessListClients) {
          tx.insert(accessListClients).values(reviveRow<typeof accessListClients.$inferInsert>(row)).run();
        }
      }

      if (Array.isArray(dbData.accessListAuth)) {
        for (const row of dbData.accessListAuth) {
          tx.insert(accessListAuth).values(reviveRow<typeof accessListAuth.$inferInsert>(row)).run();
        }
      }

      // Hosts: clear before host groups (hosts.groupId references hostGroups.id)
      if (Array.isArray(dbData.hosts)) {
        tx.delete(hosts).run();
      }

      // Host groups: clear and re-insert
      if (Array.isArray(dbData.hostGroups)) {
        tx.delete(hostGroups).run();
        for (const row of dbData.hostGroups) {
          tx.insert(hostGroups).values(reviveRow<typeof hostGroups.$inferInsert>(row)).run();
        }
      }

      // Hosts: re-insert (after host groups so FK references are valid)
      if (Array.isArray(dbData.hosts)) {
        for (const row of dbData.hosts) {
          tx.insert(hosts).values(reviveRow<typeof hosts.$inferInsert>(row)).run();
        }
      }

      // Custom templates: clear and re-insert
      if (Array.isArray(backup.customTemplates)) {
        tx.delete(customTemplates).run();
        for (const row of backup.customTemplates) {
          tx.insert(customTemplates).values(reviveRow<typeof customTemplates.$inferInsert>(row)).run();
        }
      }
    });
  } catch (err) {
    results.errors.push(
      `Failed to restore database: ${(err as Error).message}`
    );
  }

  // Validate nginx config
  const validation = validateNginxConfig();
  if (!validation.valid) {
    return Response.json(
      {
        error: "Nginx config validation failed after import",
        details: validation.error,
        results,
      },
      { status: 400 }
    );
  }

  // Reload nginx
  const reloaded = reloadNginx();
  if (!reloaded) {
    results.errors.push("Failed to reload nginx");
  }

  logAudit({
    userId: user.userId,
    action: "create",
    entity: "backup",
    details: { action: "import", configsWritten: results.configsWritten },
    ipAddress: request.headers.get("x-forwarded-for") || "unknown",
  });

  // Clean up the import cache entry
  if (body.importId) {
    removeImport(body.importId);
  }

  return Response.json({ success: true, results });
}
