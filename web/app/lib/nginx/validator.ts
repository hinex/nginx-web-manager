import { execSync } from "child_process";

/**
 * Validates the current nginx configuration using `nginx -t`.
 * Returns { valid: true } on success, or { valid: false, error: "..." } on failure.
 */
export function validateNginxConfig(): { valid: boolean; error?: string } {
  try {
    execSync("nginx -t 2>&1", { timeout: 10000, encoding: "utf-8" });
    return { valid: true };
  } catch (e: any) {
    return {
      valid: false,
      error: e.stdout || e.stderr || e.message,
    };
  }
}
