import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "fs";
import { resolve, dirname, join } from "path";
import type { AuthContext } from "~/lib/auth/authenticate";
import { requireScope, InvalidPathError, NotFoundError } from "./errors";
import { saveVersion } from "~/lib/config/versions";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { reloadNginx } from "~/lib/nginx/reload";
import { logAudit } from "~/lib/audit/log";

const DRAFT_SUFFIX = ".draft";

function nginxDir(): string {
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
