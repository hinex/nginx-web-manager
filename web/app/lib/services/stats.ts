import type { AuthContext } from "~/lib/auth/authenticate";
import { requireScope } from "./errors";
import { getSystemStats } from "~/lib/system/stats";

export function getStats(auth: AuthContext) {
  requireScope(auth, "stats:read");
  return getSystemStats();
}
