/**
 * Hosts service — draft CRUD + transactional publish with nginx -t rollback.
 *
 * Label assignments (hostLabelAssignments) are a UI-only concept that requires a
 * `labelIds` round-trip; they are intentionally out of scope for this token API.
 * Do NOT pass `labelIds` — it will be rejected as an unknown field.
 *
 * Scopes:
 *   hosts:read    — getHost, listHosts
 *   hosts:write   — createHost, updateHost, discardHostDraft
 *   hosts:publish — publishHost, deleteHost
 */

import type { AuthContext } from "~/lib/auth/authenticate";
import { requireScope, NotFoundError, HostValidationError, InputValidationError } from "./errors";
import { db } from "~/lib/db/connection";
import { hosts } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { hashBasicAuthPasswords } from "~/lib/auth/hash-basic-auth";
import { validatePublishData } from "~/lib/hosts/validate";
import { generateAllConfigs, removeHostConfig } from "~/lib/nginx/generator";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { reloadNginx } from "~/lib/nginx/reload";
import { logAudit } from "~/lib/audit/log";

// ─── Input allowlist ──────────────────────────────────────────────────────────

const ALLOWED_INPUT_KEYS = new Set([
  "domains",
  "groupId",
  "enabled",
  "sslType",
  "sslForceHttps",
  "sslCertPath",
  "sslKeyPath",
  "hsts",
  "http2",
  "compression",
  "redirectWww",
  "locations",
  "basicAuth",
  "streamPorts",
  "webhookUrl",
  "advancedNginx",
  "clientMaxBodySize",
]);

/** Hostname regex — matches single labels, dot-separated, optionally prefixed with `*.` */
const HOSTNAME_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

function validateInputShape(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new InputValidationError(`Unknown field: ${key}`);
    }
  }
  if (input.domains !== undefined) {
    if (!Array.isArray(input.domains)) throw new InputValidationError("domains must be an array");
    for (const d of input.domains as unknown[]) {
      if (typeof d !== "string" || !HOSTNAME_RE.test(d)) {
        throw new InputValidationError(`Invalid domain: ${d}`);
      }
    }
  }
  if (input.locations !== undefined && !Array.isArray(input.locations)) {
    throw new InputValidationError("locations must be an array");
  }
  if (input.streamPorts !== undefined && !Array.isArray(input.streamPorts)) {
    throw new InputValidationError("streamPorts must be an array");
  }
}

// ─── auditDetails helper (mirrors configs.ts) ────────────────────────────────

function auditDetails(auth: AuthContext, extra: Record<string, unknown>): Record<string, unknown> {
  return auth.via === "token" ? { ...extra, tokenId: auth.tokenId, via: "token" } : extra;
}

// ─── Row helpers ─────────────────────────────────────────────────────────────

type HostRow = typeof hosts.$inferSelect;

/** Pull the effective live fields out of a host row as a plain object. */
function liveFields(row: HostRow): Record<string, unknown> {
  return {
    domains: row.domains,
    groupId: row.groupId,
    enabled: row.enabled,
    sslType: row.sslType,
    sslForceHttps: row.sslForceHttps,
    sslCertPath: row.sslCertPath,
    sslKeyPath: row.sslKeyPath,
    hsts: row.hsts,
    http2: row.http2,
    compression: row.compression,
    redirectWww: row.redirectWww,
    locations: row.locations,
    basicAuth: (row as any).basicAuth,
    streamPorts: row.streamPorts,
    webhookUrl: row.webhookUrl,
    advancedNginx: row.advancedNginx,
    clientMaxBodySize: row.clientMaxBodySize,
  };
}

/** Restore a full snapshot row verbatim (used after a failed publish/delete/save). */
export function restoreSnapshot(snapshot: HostRow): void {
  db.update(hosts)
    .set({
      domains: snapshot.domains,
      groupId: snapshot.groupId,
      enabled: snapshot.enabled,
      sslType: snapshot.sslType,
      sslForceHttps: snapshot.sslForceHttps,
      sslCertPath: snapshot.sslCertPath ?? null,
      sslKeyPath: snapshot.sslKeyPath ?? null,
      hsts: snapshot.hsts,
      http2: snapshot.http2,
      compression: snapshot.compression,
      redirectWww: snapshot.redirectWww,
      locations: snapshot.locations as any,
      basicAuth: (snapshot as any).basicAuth as any,
      streamPorts: snapshot.streamPorts as any,
      webhookUrl: snapshot.webhookUrl ?? null,
      advancedNginx: snapshot.advancedNginx ?? null,
      clientMaxBodySize: snapshot.clientMaxBodySize ?? null,
      draft: snapshot.draft as any,
      updatedAt: snapshot.updatedAt,
    })
    .where(eq(hosts.id, snapshot.id))
    .run();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function listHosts(auth: AuthContext) {
  requireScope(auth, "hosts:read");
  return db.select().from(hosts).all();
}

export function getHost(auth: AuthContext, id: number): HostRow {
  requireScope(auth, "hosts:read");
  const row = db.select().from(hosts).where(eq(hosts.id, id)).get();
  if (!row) throw new NotFoundError(`Host not found: ${id}`);
  return row;
}

export async function createHost(
  auth: AuthContext,
  input: Record<string, unknown>
): Promise<HostRow> {
  requireScope(auth, "hosts:write");
  validateInputShape(input);

  const locations = (input.locations as any[]) ?? [];
  const hashed = await hashBasicAuthPasswords(
    (input.basicAuth as any) ?? null,
    locations
  );

  const row = db
    .insert(hosts)
    .values({
      domains: (input.domains as string[]) ?? [],
      groupId: (input.groupId as number | undefined) ?? undefined,
      enabled: false,
      sslType: "none",
      locations: [] as any,
      streamPorts: [] as any,
      draft: {
        ...input,
        basicAuth: hashed.basicAuth,
        locations: hashed.locations,
      } as any,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .get();

  logAudit({
    userId: auth.userId,
    action: "create",
    entity: "host",
    entityId: row.id,
    details: auditDetails(auth, { draft: true }),
  });

  return row;
}

export async function updateHost(
  auth: AuthContext,
  id: number,
  patch: Record<string, unknown>
): Promise<HostRow> {
  requireScope(auth, "hosts:write");
  validateInputShape(patch);

  const row = db.select().from(hosts).where(eq(hosts.id, id)).get();
  if (!row) throw new NotFoundError(`Host not found: ${id}`);

  const effective: Record<string, unknown> = row.draft
    ? { ...(row.draft as Record<string, unknown>) }
    : liveFields(row);

  const merged: Record<string, unknown> = { ...effective, ...patch };

  const existingBasicAuth = (effective.basicAuth as any) ?? null;
  const existingLocations = (effective.locations as any[]) ?? [];
  const patchedLocations = (merged.locations as any[]) ?? [];

  const hashed = await hashBasicAuthPasswords(
    (merged.basicAuth as any) ?? null,
    patchedLocations,
    existingBasicAuth,
    existingLocations
  );

  const updated = db
    .update(hosts)
    .set({
      draft: {
        ...merged,
        basicAuth: hashed.basicAuth,
        locations: hashed.locations,
      } as any,
      updatedAt: new Date(),
    })
    .where(eq(hosts.id, id))
    .returning()
    .get();

  logAudit({
    userId: auth.userId,
    action: "update",
    entity: "host",
    entityId: id,
    details: auditDetails(auth, { draft: true }),
  });

  return updated!;
}

export function discardHostDraft(auth: AuthContext, id: number): HostRow {
  requireScope(auth, "hosts:write");
  const row = db.select().from(hosts).where(eq(hosts.id, id)).get();
  if (!row) throw new NotFoundError(`Host not found: ${id}`);

  const updated = db
    .update(hosts)
    .set({ draft: null, updatedAt: new Date() })
    .where(eq(hosts.id, id))
    .returning()
    .get();

  logAudit({
    userId: auth.userId,
    action: "update",
    entity: "host",
    entityId: id,
    details: auditDetails(auth, { discardDraft: true }),
  });

  return updated!;
}

export async function publishHost(auth: AuthContext, id: number): Promise<HostRow> {
  requireScope(auth, "hosts:publish");

  const row = db.select().from(hosts).where(eq(hosts.id, id)).get();
  if (!row) throw new NotFoundError(`Host not found: ${id}`);

  // 1. Effective data = draft ?? live fields
  const effective: Record<string, unknown> = row.draft
    ? { ...(row.draft as Record<string, unknown>) }
    : liveFields(row);

  // Validate semantics
  const validationError = validatePublishData(effective as any);
  if (validationError) {
    throw new HostValidationError(validationError, "input");
  }

  // 2. Snapshot
  const snapshot = { ...row };

  // Hash passwords for the publish (carry existing through)
  const existingBasicAuth = (row as any).basicAuth ?? null;
  const existingLocations = (row.locations as any[]) ?? [];
  const effectiveLocations = (effective.locations as any[]) ?? [];
  const hashed = await hashBasicAuthPasswords(
    (effective.basicAuth as any) ?? null,
    effectiveLocations,
    existingBasicAuth,
    existingLocations
  );

  // 3. Write effective to main columns + clear draft
  db.update(hosts)
    .set({
      domains: (effective.domains as string[]) ?? [],
      groupId: (effective.groupId as number | null) ?? null,
      enabled: (effective.enabled as boolean) ?? true,
      sslType: (effective.sslType as any) ?? "none",
      sslForceHttps: (effective.sslForceHttps as boolean) ?? false,
      sslCertPath: (effective.sslCertPath as string | undefined) || undefined,
      sslKeyPath: (effective.sslKeyPath as string | undefined) || undefined,
      hsts: (effective.hsts as boolean) ?? true,
      http2: (effective.http2 as boolean) ?? true,
      compression: (effective.compression as boolean) ?? true,
      redirectWww: (effective.redirectWww as boolean) ?? false,
      locations: hashed.locations as any,
      basicAuth: hashed.basicAuth as any,
      streamPorts: (effective.streamPorts as any) ?? [],
      webhookUrl: (effective.webhookUrl as string | undefined) || undefined,
      advancedNginx: (effective.advancedNginx as string | undefined) || undefined,
      clientMaxBodySize: (effective.clientMaxBodySize as string | undefined) || undefined,
      draft: null,
      updatedAt: new Date(),
    })
    .where(eq(hosts.id, id))
    .run();

  // 4. Regenerate + validate
  generateAllConfigs();
  let validation: { valid: boolean; error?: string };
  try {
    validation = validateNginxConfig();
  } catch (err) {
    // Validator crash — restore snapshot, regenerate, rethrow
    restoreSnapshot(snapshot as HostRow);
    generateAllConfigs();
    throw err;
  }

  // 5. Invalid — restore and rethrow
  if (!validation.valid) {
    restoreSnapshot(snapshot as HostRow);
    generateAllConfigs();
    throw new HostValidationError(validation.error ?? "nginx config invalid", "nginx");
  }

  // 6. Valid — reload + audit + return
  reloadNginx();
  logAudit({
    userId: auth.userId,
    action: "update",
    entity: "host",
    entityId: id,
    details: auditDetails(auth, { published: true }),
  });

  return db.select().from(hosts).where(eq(hosts.id, id)).get()!;
}

export async function deleteHost(auth: AuthContext, id: number): Promise<{ deleted: true }> {
  requireScope(auth, "hosts:publish");

  const row = db.select().from(hosts).where(eq(hosts.id, id)).get();
  if (!row) throw new NotFoundError(`Host not found: ${id}`);

  // Snapshot before delete
  const snapshot = { ...row };

  // Delete row
  db.delete(hosts).where(eq(hosts.id, id)).run();

  // Remove config files + regenerate
  removeHostConfig(id);
  generateAllConfigs();

  let validation: { valid: boolean; error?: string };
  try {
    validation = validateNginxConfig();
  } catch (err) {
    // Restore row on validator crash
    db.insert(hosts)
      .values({
        id: snapshot.id,
        domains: snapshot.domains,
        groupId: snapshot.groupId ?? null,
        enabled: snapshot.enabled,
        sslType: snapshot.sslType,
        sslForceHttps: snapshot.sslForceHttps,
        sslCertPath: snapshot.sslCertPath ?? null,
        sslKeyPath: snapshot.sslKeyPath ?? null,
        hsts: snapshot.hsts,
        http2: snapshot.http2,
        compression: snapshot.compression,
        redirectWww: snapshot.redirectWww,
        locations: snapshot.locations as any,
        basicAuth: (snapshot as any).basicAuth as any,
        streamPorts: snapshot.streamPorts as any,
        webhookUrl: snapshot.webhookUrl ?? null,
        advancedNginx: snapshot.advancedNginx ?? null,
        clientMaxBodySize: snapshot.clientMaxBodySize ?? null,
        draft: snapshot.draft as any,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
      })
      .run();
    generateAllConfigs();
    throw err;
  }

  if (!validation.valid) {
    // Restore row on invalid config
    db.insert(hosts)
      .values({
        id: snapshot.id,
        domains: snapshot.domains,
        groupId: snapshot.groupId ?? null,
        enabled: snapshot.enabled,
        sslType: snapshot.sslType,
        sslForceHttps: snapshot.sslForceHttps,
        sslCertPath: snapshot.sslCertPath ?? null,
        sslKeyPath: snapshot.sslKeyPath ?? null,
        hsts: snapshot.hsts,
        http2: snapshot.http2,
        compression: snapshot.compression,
        redirectWww: snapshot.redirectWww,
        locations: snapshot.locations as any,
        basicAuth: (snapshot as any).basicAuth as any,
        streamPorts: snapshot.streamPorts as any,
        webhookUrl: snapshot.webhookUrl ?? null,
        advancedNginx: snapshot.advancedNginx ?? null,
        clientMaxBodySize: snapshot.clientMaxBodySize ?? null,
        draft: snapshot.draft as any,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
      })
      .run();
    generateAllConfigs();
    throw new HostValidationError(validation.error ?? "nginx config invalid", "nginx");
  }

  reloadNginx();
  logAudit({
    userId: auth.userId,
    action: "delete",
    entity: "host",
    entityId: id,
    details: auditDetails(auth, {}),
  });

  return { deleted: true };
}
