import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "fs";
import { resolve, dirname, join, basename } from "path";
import { eq } from "drizzle-orm";
import type { AuthContext } from "~/lib/auth/authenticate";
import { requireScope, InvalidPathError, NotFoundError, ConfigClassificationError } from "./errors";
import { saveVersion } from "~/lib/config/versions";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { reloadNginx } from "~/lib/nginx/reload";
import { logAudit } from "~/lib/audit/log";
import { db } from "~/lib/db/connection";
import { hosts, settings } from "~/lib/db/schema";
import { mapHostToConfig, loadAccessLists } from "~/lib/nginx/generator";
import { buildServerBlock, type HostConfig } from "~/lib/nginx/templates/server-block";
import { parse } from "~/lib/nginx/parser";
import { diffAst } from "~/lib/nginx/reverse/match";
import { classifyDelta, type ClassifiedEdit, type Refusal } from "~/lib/nginx/reverse/classify";
import { syntaxError } from "~/lib/nginx/reverse/syntax";
import { applyEdits } from "~/lib/nginx/reverse/apply";

const DRAFT_SUFFIX = ".draft";

export function nginxDir(): string {
  return resolve(process.env.NGINX_DIR || "/data/nginx");
}

function auditDetails(auth: AuthContext, extra: Record<string, unknown>) {
  return auth.via === "token" ? { ...extra, tokenId: auth.tokenId, via: "token" } : extra;
}

/**
 * Walk dirname() upward until we find a path that exists on disk, stopping at
 * the filesystem root ("/") to prevent an infinite loop.
 */
function nearestExistingAncestor(p: string): string {
  let cur = dirname(p);
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return cur; // reached filesystem root
    cur = parent;
  }
  return cur;
}

export function resolveConfigPath(
  filePath: string,
  opts: { allowDraft?: boolean } = {}
): string {
  if (typeof filePath !== "string" || !filePath) {
    throw new InvalidPathError(String(filePath));
  }
  const dir = nginxDir();
  const p = resolve(dir, filePath);

  // Cheap string-containment check first (no syscall).
  if (p !== dir && !p.startsWith(dir + "/")) throw new InvalidPathError(filePath);

  // Extension check before expensive realpath work.
  const isConf = p.endsWith(".conf");
  const isDraft = p.endsWith(".conf" + DRAFT_SUFFIX);
  if (!(isConf || (opts.allowDraft && isDraft))) throw new InvalidPathError(filePath);

  // Realpath containment: resolve symlinks on both the nginx dir and the target
  // path (or its nearest existing ancestor if the file doesn't exist yet).
  const realDir = realpathSync(dir);
  let realTarget: string;
  if (existsSync(p)) {
    realTarget = realpathSync(p);
  } else {
    const ancestor = nearestExistingAncestor(p);
    // remainder is the path from the ancestor downward (the not-yet-created portion)
    const remainder = p.slice(ancestor.length);
    realTarget = realpathSync(ancestor) + remainder;
  }

  if (realTarget !== realDir && !realTarget.startsWith(realDir + "/")) {
    throw new InvalidPathError(filePath);
  }

  return realTarget;
}

export function listConfigs(auth: AuthContext): { files: string[]; drafts: string[] } {
  requireScope(auth, "configs:read");
  const files: string[] = [];
  const drafts: string[] = [];
  function walk(d: string) {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".conf" + DRAFT_SUFFIX)) drafts.push(full);
      else if (entry.name.endsWith(".conf")) files.push(full);
    }
  }
  walk(nginxDir());
  return { files, drafts };
}

export function readConfig(auth: AuthContext, filePath: string): string {
  requireScope(auth, "configs:read");
  const p = resolveConfigPath(filePath, { allowDraft: true });
  if (!existsSync(p)) throw new NotFoundError(`File not found: ${filePath}`);
  return readFileSync(p, "utf-8");
}

export interface DraftWriteResult {
  draftPath: string;
  valid: boolean;
  error?: string;
}

export function writeConfigDraft(
  auth: AuthContext,
  filePath: string,
  content: string,
  message?: string
): DraftWriteResult {
  requireScope(auth, "configs:write");
  if (typeof content !== "string") throw new Error("content must be a string");
  const livePath = resolveConfigPath(filePath);
  const draftPath = livePath + DRAFT_SUFFIX;

  const original = existsSync(livePath) ? readFileSync(livePath, "utf-8") : null;
  if (original !== null) {
    saveVersion({
      filePath: livePath,
      content: original,
      changeType: "manual_edit",
      userId: auth.userId,
      message: message || "Draft written via API",
    });
  }

  mkdirSync(dirname(draftPath), { recursive: true });
  writeFileSync(draftPath, content);

  // Validate by temporarily swapping the content into the live path.
  // nginx only applies config on reload, so this is invisible to the running server.
  writeFileSync(livePath, content);
  let validation: { valid: boolean; error?: string };
  try {
    validation = validateNginxConfig();
  } finally {
    if (original !== null) writeFileSync(livePath, original);
    else unlinkSync(livePath);
  }

  logAudit({
    userId: auth.userId,
    action: original !== null ? "update" : "create",
    entity: "config_draft",
    details: auditDetails(auth, { filePath: livePath, valid: validation!.valid }),
  });

  return {
    draftPath,
    valid: validation!.valid,
    error: validation!.valid ? undefined : validation!.error,
  };
}

export interface LiveWriteResult {
  saved: boolean;
  valid: boolean;
  reloaded: boolean;
  error?: string;
}

/**
 * Write straight to a live config file. Unlike writeConfigDraft this touches
 * what nginx actually serves, so a failed `nginx -t` is rolled back before we
 * return: the caller never ends up with a broken file on disk.
 */
export function writeConfigLive(
  auth: AuthContext,
  filePath: string,
  content: string,
  message?: string
): LiveWriteResult {
  requireScope(auth, "configs:publish");
  const livePath = resolveConfigPath(filePath);

  const original = existsSync(livePath) ? readFileSync(livePath, "utf-8") : null;
  if (original !== null) {
    saveVersion({
      filePath: livePath,
      content: original,
      changeType: "manual_edit",
      userId: auth.userId,
      message,
    });
  }

  writeFileSync(livePath, content);

  let validation: { valid: boolean; error?: string };
  try {
    validation = validateNginxConfig();
  } catch (err) {
    // Restore before propagating: the validator itself blew up (spawn failure),
    // we still must not leave unvalidated content live.
    if (original !== null) writeFileSync(livePath, original);
    else unlinkSync(livePath);
    throw err;
  }

  if (!validation.valid) {
    if (original !== null) writeFileSync(livePath, original);
    else unlinkSync(livePath);
    return { saved: false, valid: false, reloaded: false, error: validation.error };
  }

  const reloaded = reloadNginx();
  logAudit({
    userId: auth.userId,
    action: "update",
    entity: "config",
    details: auditDetails(auth, { filePath: livePath, reloaded }),
  });

  return { saved: true, valid: true, reloaded };
}

export interface PublishResult {
  published: boolean;
  valid: boolean;
  error?: string;
}

export function publishConfig(auth: AuthContext, filePath: string): PublishResult {
  requireScope(auth, "configs:publish");
  const livePath = resolveConfigPath(filePath);
  const draftPath = livePath + DRAFT_SUFFIX;
  if (!existsSync(draftPath)) throw new NotFoundError(`No draft for ${filePath}`);

  const draftContent = readFileSync(draftPath, "utf-8");
  const original = existsSync(livePath) ? readFileSync(livePath, "utf-8") : null;
  if (original !== null) {
    saveVersion({
      filePath: livePath,
      content: original,
      changeType: "manual_edit",
      userId: auth.userId,
      message: "Before publish via API",
    });
  }

  writeFileSync(livePath, draftContent);
  let validation: { valid: boolean; error?: string };
  try {
    validation = validateNginxConfig();
  } catch (err) {
    // Restore live content if the validator itself blows up (spawn failure etc.)
    if (original !== null) writeFileSync(livePath, original);
    else unlinkSync(livePath);
    throw err;
  }
  if (!validation.valid) {
    if (original !== null) writeFileSync(livePath, original);
    else unlinkSync(livePath);
    return { published: false, valid: false, error: validation.error };
  }

  unlinkSync(draftPath);
  reloadNginx();
  logAudit({
    userId: auth.userId,
    action: "update",
    entity: "config",
    details: auditDetails(auth, { filePath: livePath, published: true }),
  });
  return { published: true, valid: true };
}

// ─── Reverse-sync: hand-edited config → host model ──────

/**
 * `hostId` is `null` when the file isn't a managed `host-<id>.conf` — there is
 * nothing to classify and the caller should offer a plain save, not a diff
 * dialog. Callers must branch on `null` explicitly rather than treating a
 * missing host as "a host with no changes".
 */
export interface ConfigEditPreview {
  hostId: number | null;
  edits: ClassifiedEdit[];
  refusals: Refusal[];
}

interface ClassifyResult {
  hostId: number;
  hostConfig: HostConfig;
  edits: ClassifiedEdit[];
  refusals: Refusal[];
}

const DRAFT_REFUSAL_REASON =
  "This host has an unpublished draft. Publish or discard it before editing the file.";

/**
 * Render the server block for a host row exactly as `generateAllConfigs`
 * would, so the reverse-sync diff compares like with like. Not pure: reads
 * DNS settings and probes the error-pages directory (via `mapHostToConfig`).
 */
function renderHost(row: typeof hosts.$inferSelect): string {
  const dnsResolver = db.select().from(settings).where(eq(settings.key, "dns_resolver")).get()?.value || "";
  const dnsResolverValid =
    db.select().from(settings).where(eq(settings.key, "dns_resolver_valid")).get()?.value || "30s";
  const accessListMap = loadAccessLists();
  return buildServerBlock(mapHostToConfig(row, dnsResolver, dnsResolverValid), accessListMap);
}

/**
 * Shared by `previewConfigEdit` and `applyConfigEdit` so classification can
 * never drift between the two. Returns `null` when `filePath` isn't a
 * managed `host-<id>.conf` file (or no such host row exists) — the caller
 * falls back to a plain `writeConfigLive`.
 */
function classifyFor(filePath: string, content: string): ClassifyResult | null {
  const livePath = resolveConfigPath(filePath);
  const m = /^host-(\d+)\.conf$/.exec(basename(livePath));
  if (!m) return null;
  const hostId = Number(m[1]);

  const row = db.select().from(hosts).where(eq(hosts.id, hostId)).get();
  if (!row) return null;

  if (row.draft !== null) {
    throw new ConfigClassificationError([{ line: 0, directive: "", reason: DRAFT_REFUSAL_REASON }]);
  }

  const problem = syntaxError(content);
  if (problem) {
    return {
      hostId,
      hostConfig: mapHostToConfig(row, "", "30s"),
      edits: [],
      refusals: [{ line: problem.line, directive: "", reason: problem.message }],
    };
  }

  const dnsResolver = db.select().from(settings).where(eq(settings.key, "dns_resolver")).get()?.value || "";
  const dnsResolverValid =
    db.select().from(settings).where(eq(settings.key, "dns_resolver_valid")).get()?.value || "30s";
  const hostConfig = mapHostToConfig(row, dnsResolver, dnsResolverValid);

  const expected = parse(renderHost(row));
  const actual = parse(content);
  const delta = diffAst(expected, actual);
  const { edits, refusals } = classifyDelta(delta, hostConfig);

  return { hostId, hostConfig, edits, refusals };
}

/**
 * Builds the DB column patch for a batch of classified edits. Location-shaped
 * edits (field/advanced/removed/added) all land in the single `locations`
 * JSON column, so any one of them touches the whole array.
 */
function touchedColumns(edits: ClassifiedEdit[], updated: HostConfig): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const edit of edits) {
    switch (edit.kind) {
      case "field":
        patch[edit.field] = (updated as unknown as Record<string, unknown>)[edit.field];
        break;
      case "location-field":
      case "location-advanced":
      case "location-removed":
      case "location-added":
        patch.locations = updated.locations;
        break;
      case "prelude":
        patch.customPrelude = updated.customPrelude;
        break;
      case "server-advanced":
        patch.advancedNginx = updated.advancedNginx;
        break;
    }
  }
  return patch;
}

/** Per-edit audit detail shape: `{ field, from, to, source: "config-editor" }`. */
function auditFieldFor(edit: ClassifiedEdit): { field: string; from: unknown; to: unknown; source: string } {
  const source = "config-editor";
  switch (edit.kind) {
    case "field":
      return { field: edit.field, from: edit.from, to: edit.to, source };
    case "location-field":
      return { field: `locations[${edit.index}].${edit.field}`, from: edit.from, to: edit.to, source };
    case "location-advanced":
      return { field: `locations[${edit.index}].advanced`, from: null, to: edit.text, source };
    case "location-removed":
      return { field: `locations[${edit.index}]`, from: edit.label, to: null, source };
    case "location-added":
      return {
        field: "locations[+]",
        from: null,
        to: { path: edit.path, matchType: edit.matchType, type: edit.type },
        source,
      };
    case "prelude":
      return { field: "customPrelude", from: null, to: edit.text, source };
    case "server-advanced":
      return { field: "advancedNginx", from: null, to: edit.text, source };
  }
}

/**
 * Classify a hand-edited config against the host model without applying
 * anything. Used by the editor to show a confirmation dialog before saving.
 */
export function previewConfigEdit(auth: AuthContext, filePath: string, content: string): ConfigEditPreview {
  requireScope(auth, "configs:read");
  const c = classifyFor(filePath, content);
  if (c === null) return { hostId: null, edits: [], refusals: [] };
  return { hostId: c.hostId, edits: c.edits, refusals: c.refusals };
}

/**
 * Reverse-sync a hand-edited config back into the host model, then write the
 * regenerated file through `writeConfigLive` so `nginx -t` still guards the
 * live path. If any change can't be mapped, nothing is written; if the
 * regenerated config fails validation, both the DB update and the file write
 * are rolled back.
 */
export function applyConfigEdit(
  auth: AuthContext,
  filePath: string,
  content: string
): LiveWriteResult & { applied: ClassifiedEdit[] } {
  // Writing any live config file needs `configs:publish` — that is what the
  // plain path has always required. Check it before classifying so an
  // unprivileged caller can't provoke a parse or learn a host's draft state
  // from the error. `hosts:publish` is demanded only once we know this file
  // really is a managed host and the write will mutate the host model;
  // editing a hand-written `conf.d/*.conf` must not require host rights.
  requireScope(auth, "configs:publish");

  const c = classifyFor(filePath, content);
  if (c === null) {
    return { ...writeConfigLive(auth, filePath, content), applied: [] };
  }

  requireScope(auth, "hosts:publish");

  if (c.refusals.length > 0) {
    throw new ConfigClassificationError(c.refusals);
  }

  const updated = applyEdits(c.hostConfig, c.edits);
  const patch = touchedColumns(c.edits, updated);

  let result!: LiveWriteResult;
  db.transaction((tx) => {
    tx.update(hosts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(hosts.id, c.hostId))
      .run();
    const row = tx.select().from(hosts).where(eq(hosts.id, c.hostId)).get()!;
    const regenerated = renderHost(row);
    result = writeConfigLive(auth, filePath, regenerated);
    if (!result.valid) {
      throw new ConfigClassificationError([
        { line: 0, directive: "", reason: `Regenerated config failed nginx -t: ${result.error}` },
      ]);
    }
  });

  for (const edit of c.edits) {
    logAudit({
      userId: auth.userId,
      action: "update",
      entity: "host",
      entityId: c.hostId,
      details: auditDetails(auth, auditFieldFor(edit)),
    });
  }

  return { ...result, applied: c.edits };
}

export function deleteConfig(auth: AuthContext, filePath: string): { deleted: true } {
  requireScope(auth, "configs:publish");
  const livePath = resolveConfigPath(filePath, { allowDraft: true });
  if (!existsSync(livePath)) throw new NotFoundError(`File not found: ${filePath}`);

  saveVersion({
    filePath: livePath,
    content: readFileSync(livePath, "utf-8"),
    changeType: "manual_edit",
    userId: auth.userId,
    message: "Deleted via API",
  });
  unlinkSync(livePath);
  const validation = validateNginxConfig();
  if (validation.valid) reloadNginx();
  logAudit({
    userId: auth.userId,
    action: "delete",
    entity: "config",
    details: auditDetails(auth, { filePath: livePath }),
  });
  return { deleted: true };
}
