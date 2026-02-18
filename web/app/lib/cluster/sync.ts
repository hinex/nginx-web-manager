import { db } from "~/lib/db/connection";
import { clusterNodes, configSyncTags } from "~/lib/db/schema";
import { listConfigFiles } from "~/lib/nginx/parser";
import { readFileSync } from "fs";
import { eq } from "drizzle-orm";

const NGINX_DIR = process.env.NGINX_DIR || "/data/nginx";

export interface SyncResult {
  nodeId: number;
  nodeName: string;
  success: boolean;
  error?: string;
}

/**
 * Sync configs to a single worker node.
 * Collects all nginx config files and pushes them to the worker via HTTP.
 */
export async function syncToNode(nodeId: number): Promise<SyncResult> {
  const node = db
    .select()
    .from(clusterNodes)
    .where(eq(clusterNodes.id, nodeId))
    .get();

  if (!node) {
    return { nodeId, nodeName: "unknown", success: false, error: "Node not found" };
  }

  try {
    // Mark as syncing
    db.update(clusterNodes)
      .set({ status: "syncing" })
      .where(eq(clusterNodes.id, nodeId))
      .run();

    // Collect all config files, filtering out local-only tagged files
    const files = listConfigFiles(NGINX_DIR);

    // Build a set of local-only file paths from sync tags
    const localOnlyTags = db
      .select()
      .from(configSyncTags)
      .where(eq(configSyncTags.syncMode, "local-only"))
      .all();
    const localOnlyPaths = new Set(localOnlyTags.map((t) => t.filePath));

    const configs: Record<string, string> = {};
    for (const file of files) {
      if (localOnlyPaths.has(file)) {
        console.log(`[cluster-sync] Skipping local-only file: ${file}`);
        continue;
      }
      try {
        configs[file] = readFileSync(file, "utf-8");
      } catch {
        // Skip unreadable files
      }
    }

    // Push to worker
    const res = await fetch(`${node.url}/api/cluster-receive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cluster-Key": node.apiKey,
      },
      body: JSON.stringify({ configs }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Worker responded ${res.status}: ${text}`);
    }

    // Mark as online
    db.update(clusterNodes)
      .set({ status: "online", lastSyncAt: new Date(), lastError: null })
      .where(eq(clusterNodes.id, nodeId))
      .run();

    return { nodeId, nodeName: node.name, success: true };
  } catch (err) {
    const error = (err as Error).message;
    db.update(clusterNodes)
      .set({ status: "error", lastError: error })
      .where(eq(clusterNodes.id, nodeId))
      .run();
    return { nodeId, nodeName: node.name, success: false, error };
  }
}

/**
 * Sync configs to all worker nodes in parallel.
 */
export async function syncToAllNodes(): Promise<SyncResult[]> {
  const nodes = db
    .select()
    .from(clusterNodes)
    .where(eq(clusterNodes.role, "worker"))
    .all();

  return Promise.all(nodes.map((n) => syncToNode(n.id)));
}
