import type { Route } from "./+types/terminal-token";
import { requireAdmin } from "~/lib/auth/middleware";
import { createToken } from "~/lib/auth/jwt.server";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAdmin(request);

  // Create a short-lived token for WebSocket authentication
  const token = await createToken({
    userId: user.userId,
    email: user.email,
    role: user.role,
  });

  return Response.json({ token });
}
