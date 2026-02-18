import { execSync } from "child_process";

/**
 * Reloads nginx configuration gracefully.
 * Tries s6-overlay first (Docker), falls back to `nginx -s reload`.
 */
export function reloadNginx(): boolean {
  try {
    execSync("s6-svc -h /run/s6-rc/servicedirs/nginx", { timeout: 5000 });
    return true;
  } catch {
    try {
      execSync("nginx -s reload", { timeout: 5000 });
      return true;
    } catch {
      console.error("[reload] Failed to reload Nginx");
      return false;
    }
  }
}
