import type { AuthContext } from "~/lib/auth/authenticate";
import { requireScope } from "./errors";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { reloadNginx } from "~/lib/nginx/reload";
import { logAudit } from "~/lib/audit/log";

export function validate(auth: AuthContext): { valid: boolean; error?: string } {
  requireScope(auth, "nginx:validate");
  return validateNginxConfig();
}

export function reload(auth: AuthContext): { reloaded: boolean } {
  requireScope(auth, "nginx:reload");
  const ok = reloadNginx();
  logAudit({
    userId: auth.userId,
    action: "reload",
    entity: "nginx",
    details: auth.via === "token" ? { tokenId: auth.tokenId, via: "token" } : {},
  });
  return { reloaded: ok };
}
