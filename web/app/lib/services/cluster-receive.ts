import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { resolveConfigPath, nginxDir } from "./configs";
import { InvalidPathError } from "./errors";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { reloadNginx } from "~/lib/nginx/reload";

export interface ClusterApplyResult {
  written: number;
  rejected: string[];
  errors: string[];
  valid: boolean;
  reloaded: boolean;
  validationError?: string;
}

/**
 * Apply a batch of config files pushed by a cluster controller.
 *
 * Every path is containment-checked BEFORE anything is written: a batch that
 * contains a single escape attempt is refused wholesale rather than applied
 * halfway. A batch that fails `nginx -t` is rolled back to the previous
 * contents of every file it touched.
 */
export function applyClusterConfigs(configs: Record<string, string>): ClusterApplyResult {
  const rejected: string[] = [];
  const errors: string[] = [];
  const targets: Array<{ given: string; realPath: string; content: string }> = [];

  // Bootstrap: a fresh worker has no NGINX_DIR yet, and resolveConfigPath
  // realpath()s it unguarded. Without this the first sync 500s forever.
  try {
    mkdirSync(nginxDir(), { recursive: true });
  } catch (err) {
    errors.push(`${nginxDir()}: ${(err as Error).message}`);
  }

  for (const [path, content] of Object.entries(configs)) {
    try {
      targets.push({
        given: path,
        realPath: resolveConfigPath(path),
        content: content as string,
      });
    } catch (err) {
      if (err instanceof InvalidPathError) {
        rejected.push(path);
      } else {
        // ENOENT/EACCES on the nginx dir itself — refuse the entry, never 500.
        rejected.push(path);
        errors.push(`${path}: ${(err as Error).message}`);
      }
    }
  }

  if (rejected.length > 0) {
    return { written: 0, rejected, errors, valid: false, reloaded: false };
  }

  const snapshots = targets.map((t) => ({
    realPath: t.realPath,
    previous: existsSync(t.realPath) ? readFileSync(t.realPath, "utf-8") : null,
  }));

  let written = 0;
  for (const { given, realPath, content } of targets) {
    try {
      mkdirSync(dirname(realPath), { recursive: true });
      writeFileSync(realPath, content);
      written++;
    } catch (err) {
      errors.push(`${given}: ${(err as Error).message}`);
    }
  }

  const validation = validateNginxConfig();
  if (!validation.valid) {
    for (const { realPath, previous } of snapshots) {
      try {
        if (previous !== null) writeFileSync(realPath, previous);
        else unlinkSync(realPath);
      } catch (err) {
        errors.push(`${realPath}: rollback failed: ${(err as Error).message}`);
      }
    }
    return {
      written: 0,
      rejected,
      errors,
      valid: false,
      reloaded: false,
      validationError: validation.error,
    };
  }

  const reloaded = reloadNginx();
  return { written, rejected, errors, valid: true, reloaded };
}
