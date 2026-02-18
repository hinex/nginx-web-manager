import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { clearSessionCookie, getSessionUser } from "~/lib/auth/session.server";
import { logAudit } from "~/lib/audit/log";

export async function action({ request }: Route.ActionArgs) {
  const user = await getSessionUser(request);
  logAudit({
    userId: user?.userId ?? null,
    action: "logout",
    entity: "user",
    entityId: user?.userId,
    ipAddress: request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown",
  });

  return redirect("/login", {
    headers: { "Set-Cookie": clearSessionCookie() },
  });
}
