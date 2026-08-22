import { join, resolve } from "node:path";

/**
 * Root of the managed config tree that this app owns and regenerates.
 *
 * `NGINX_DIR` is the supported name. `DATA_NGINX_DIR` is a deprecated alias,
 * honoured only when `NGINX_DIR` is unset. The alias used to be read by the
 * generator alone while eight other modules read `NGINX_DIR` directly, so a
 * deployment that set only `DATA_NGINX_DIR` pointed the generator and the
 * editor at different directories and every edit made in the editor was lost
 * on the next regeneration. This module is the single place that decides.
 *
 * Read at call time, not at import time: a module-scope capture is invisible to
 * anything that sets the variable after the import graph is built (and untestable
 * without `vi.resetModules()`).
 */
export function nginxDir(): string {
  return resolve(process.env.NGINX_DIR || process.env.DATA_NGINX_DIR || "/data/nginx");
}

/** Per-host `server {}` files. */
export function hostConfDir(): string {
  return join(nginxDir(), "conf.d");
}

/** Per-host `stream {}` files. */
export function streamConfDir(): string {
  return join(nginxDir(), "stream.d");
}

/** Generated htpasswd files for basic auth. */
export function authDir(): string {
  return join(nginxDir(), "auth");
}
