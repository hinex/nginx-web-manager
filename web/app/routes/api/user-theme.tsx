import type { Route } from "./+types/user-theme";
import { requireAuth } from "~/lib/auth/middleware";
import { db } from "~/lib/db/connection";
import { users } from "~/lib/db/schema";
import { eq } from "drizzle-orm";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAuth(request);
  const row = db
    .select({ theme: users.theme })
    .from(users)
    .where(eq(users.id, user.userId))
    .get();
  return Response.json({ theme: row?.theme ?? null });
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireAuth(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { theme } = body as { theme?: string };

  if (!theme || !["light", "dark", "system"].includes(theme)) {
    return Response.json(
      { error: "Invalid theme. Must be 'light', 'dark', or 'system'." },
      { status: 400 }
    );
  }

  db.update(users)
    .set({ theme, updatedAt: new Date() })
    .where(eq(users.id, user.userId))
    .run();

  return Response.json({ ok: true, theme });
}
