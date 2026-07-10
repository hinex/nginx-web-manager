import type { Route } from "./+types/logs";
import { existsSync, readFileSync } from "fs";
import { requireAuth } from "~/lib/auth/middleware";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAuth(request);

  const url = new URL(request.url);
  const hostId = url.searchParams.get("hostId");
  const type = url.searchParams.get("type") === "error" ? "error" : "access";
  const lines = Number(url.searchParams.get("lines")) || 100;

  if (!hostId || !/^\d+$/.test(hostId)) {
    return Response.json({ lines: [] });
  }

  const logFile = `/data/logs/host-${hostId}_${type}.log`;

  if (!existsSync(logFile)) {
    return Response.json({ lines: [] });
  }

  try {
    const content = readFileSync(logFile, "utf-8");
    const allLines = content.split("\n").filter((l) => l.trim());
    const lastLines = allLines.slice(-lines);
    return Response.json({ lines: lastLines });
  } catch {
    return Response.json({ lines: [] });
  }
}
