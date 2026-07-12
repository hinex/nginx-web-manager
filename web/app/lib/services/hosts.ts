import type { AuthContext } from "~/lib/auth/authenticate";
import { requireScope } from "./errors";
import { db } from "~/lib/db/connection";
import { hosts } from "~/lib/db/schema";

export function listHosts(auth: AuthContext) {
  requireScope(auth, "hosts:read");
  return db.select().from(hosts).all();
}
