import { redirect } from "react-router";
import { getSessionUser } from "~/lib/auth/session.server";
import type { Route } from "./+types/home";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getSessionUser(request);
  throw redirect(user ? "/admin" : "/login");
}
