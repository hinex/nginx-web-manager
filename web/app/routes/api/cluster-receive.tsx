import { timingSafeEqual } from "crypto";
import { applyClusterConfigs } from "~/lib/services/cluster-receive";

function keysMatch(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const clusterKey = request.headers.get("x-cluster-key");
  const expectedKey = process.env.CLUSTER_API_KEY;

  if (!keysMatch(clusterKey, expectedKey)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { configs } = await request.json();

  if (!configs || typeof configs !== "object" || Array.isArray(configs)) {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }

  const result = applyClusterConfigs(configs as Record<string, string>);

  if (result.rejected.length > 0) {
    console.error(`[cluster-receive] rejected out-of-tree paths: ${result.rejected.join(", ")}`);
    return Response.json(
      { error: "Rejected paths outside the nginx config directory", rejected: result.rejected },
      { status: 400 }
    );
  }

  if (!result.valid) {
    return Response.json(
      { error: "Config validation failed", details: result.validationError, results: result },
      { status: 400 }
    );
  }

  return Response.json({ success: true, results: result });
}
