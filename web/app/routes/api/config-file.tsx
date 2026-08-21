import type { Route } from "./+types/config-file";
import { requireEditor } from "~/lib/auth/middleware";
import { saveVersion, getVersions, getVersion, diffVersions } from "~/lib/config/versions";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { reloadNginx } from "~/lib/nginx/reload";
import { logAudit } from "~/lib/audit/log";
import { previewConfigEdit, applyConfigEdit } from "~/lib/services/configs";
import { InvalidPathError, ForbiddenError, ConfigClassificationError } from "~/lib/services/errors";
import type { AuthContext } from "~/lib/auth/authenticate";
import { ROLE_CEILINGS, type Role } from "~/lib/auth/scopes";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { resolve } from "path";

const NGINX_DIR = resolve(process.env.NGINX_DIR || "/data/nginx");

function isAllowedPath(filePath: unknown): filePath is string {
  if (typeof filePath !== "string" || !filePath) return false;
  const p = resolve(filePath);
  return (p === NGINX_DIR || p.startsWith(NGINX_DIR + "/")) && p.endsWith(".conf");
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireEditor(request);
  const auth: AuthContext = {
    userId: user.userId,
    role: user.role as Role,
    via: "session",
    scopes: ROLE_CEILINGS[user.role as Role] ?? [],
  };
  const body = await request.json();
  const { action: act } = body;

  switch (act) {
    case "read": {
      const { filePath } = body;
      if (!isAllowedPath(filePath)) {
        return Response.json({ error: "Invalid path" }, { status: 400 });
      }
      if (!existsSync(filePath)) {
        return Response.json({ error: "File not found" }, { status: 404 });
      }
      const content = readFileSync(filePath, "utf-8");
      return Response.json({ content });
    }

    // Classifies a hand-edited config against the host model without writing
    // anything, so the editor can show the ApplyDialog confirmation before save.
    case "preview": {
      const { filePath, content } = body;
      if (typeof filePath !== "string" || typeof content !== "string") {
        return Response.json({ error: "filePath and content required" }, { status: 400 });
      }
      try {
        const preview = previewConfigEdit(auth, filePath, content);
        return Response.json(preview);
      } catch (err) {
        if (err instanceof ConfigClassificationError) {
          return Response.json({ refusals: err.refusals }, { status: 422 });
        }
        if (err instanceof InvalidPathError) {
          return Response.json({ error: "Invalid path" }, { status: 400 });
        }
        if (err instanceof ForbiddenError) {
          return Response.json({ error: err.message }, { status: 403 });
        }
        throw err;
      }
    }

    case "write": {
      const { filePath, content } = body;
      if (typeof filePath !== "string" || typeof content !== "string") {
        return Response.json({ error: "filePath and content required" }, { status: 400 });
      }
      try {
        // Reverse-syncs the edit into the host model when filePath is a managed
        // host-<id>.conf; falls back to a plain writeConfigLive otherwise. Never
        // silent: an unmappable delta throws ConfigClassificationError below
        // instead of writing anything.
        const result = applyConfigEdit(auth, filePath, content);
        return Response.json(result);
      } catch (err) {
        if (err instanceof ConfigClassificationError) {
          return Response.json({ refusals: err.refusals }, { status: 422 });
        }
        if (err instanceof InvalidPathError) {
          return Response.json({ error: "Invalid path" }, { status: 400 });
        }
        if (err instanceof ForbiddenError) {
          return Response.json({ error: err.message }, { status: 403 });
        }
        throw err;
      }
    }

    case "delete": {
      const { filePath } = body;
      if (!isAllowedPath(filePath)) {
        return Response.json({ error: "Invalid path" }, { status: 400 });
      }
      if (!existsSync(filePath)) {
        return Response.json({ error: "File not found" }, { status: 404 });
      }
      const oldContent = readFileSync(filePath, "utf-8");
      saveVersion({
        filePath,
        content: oldContent,
        changeType: "manual_edit",
        userId: user.userId,
        message: "Deleted",
      });
      unlinkSync(filePath);
      const validation = validateNginxConfig();
      if (!validation.valid) {
        writeFileSync(filePath, oldContent);
        return Response.json({ deleted: false, valid: false, error: validation.error });
      }
      const reloaded = reloadNginx();
      logAudit({
        userId: user.userId,
        action: "delete",
        entity: "config",
        details: { filePath, reloaded },
      });
      return Response.json({ deleted: true, valid: true, reloaded });
    }

    case "versions": {
      const { filePath } = body;
      if (!isAllowedPath(filePath)) {
        return Response.json({ error: "Invalid path" }, { status: 400 });
      }
      const { db: database } = await import("~/lib/db/connection");
      const { users: usersTable } = await import("~/lib/db/schema");
      const versions = getVersions(filePath);
      const allUsers = database.select({ id: usersTable.id, email: usersTable.email }).from(usersTable).all();
      const userMap = new Map(allUsers.map((u: { id: number; email: string }) => [u.id, u.email]));
      const versionsWithUser = versions.map((v) => ({
        ...v,
        userEmail: v.userId ? userMap.get(v.userId) ?? null : null,
      }));
      return Response.json({ versions: versionsWithUser });
    }

    case "diff": {
      const { versionIdA, versionIdB, filePath } = body;
      if (versionIdA && versionIdB) {
        const a = getVersion(versionIdA);
        const b = getVersion(versionIdB);
        if (!a || !b) {
          return Response.json({ error: "Version not found" }, { status: 404 });
        }
        const diff = diffVersions(a.content, b.content);
        return Response.json({ diff });
      }
      if (versionIdA && filePath) {
        if (!isAllowedPath(filePath)) {
          return Response.json({ error: "Invalid path" }, { status: 400 });
        }
        const a = getVersion(versionIdA);
        if (!a || !existsSync(filePath)) {
          return Response.json({ error: "Version or file not found" }, { status: 404 });
        }
        const current = readFileSync(filePath, "utf-8");
        const diff = diffVersions(a.content, current);
        return Response.json({ diff });
      }
      return Response.json({ error: "versionIdA and versionIdB (or filePath) required" }, { status: 400 });
    }

    case "restore": {
      const { versionId } = body;
      if (!versionId) {
        return Response.json({ error: "versionId required" }, { status: 400 });
      }
      const version = getVersion(versionId);
      if (!version) {
        return Response.json({ error: "Version not found" }, { status: 404 });
      }
      if (!isAllowedPath(version.filePath)) {
        return Response.json({ error: "Invalid path" }, { status: 400 });
      }
      if (existsSync(version.filePath)) {
        const current = readFileSync(version.filePath, "utf-8");
        saveVersion({
          filePath: version.filePath,
          content: current,
          changeType: "restore",
          userId: user.userId,
          message: `Before restore to version ${versionId}`,
        });
      }
      const previous = existsSync(version.filePath) ? readFileSync(version.filePath, "utf-8") : null;
      writeFileSync(version.filePath, version.content);
      const validation = validateNginxConfig();
      if (!validation.valid) {
        if (previous !== null) writeFileSync(version.filePath, previous);
        else unlinkSync(version.filePath);
        return Response.json({ restored: false, valid: false, error: validation.error });
      }
      const reloaded = reloadNginx();
      logAudit({
        userId: user.userId,
        action: "update",
        entity: "config",
        details: { filePath: version.filePath, restoredFromVersion: versionId, reloaded },
      });
      return Response.json({ restored: true, valid: true, reloaded });
    }

    default:
      return Response.json({ error: "Unknown action" }, { status: 400 });
  }
}
