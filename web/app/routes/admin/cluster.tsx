import type { Route } from "./+types/cluster";
import { useFetcher } from "react-router";
import { db } from "~/lib/db/connection";
import { clusterNodes, configSyncTags } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { requireAdmin } from "~/lib/auth/middleware";
import { syncToNode, syncToAllNodes } from "~/lib/cluster/sync";
import { listConfigFiles } from "~/lib/nginx/parser";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  Plus,
  RefreshCw,
  Trash2,
  Loader2,
  Globe,
  Lock,
} from "lucide-react";
import { PageHeader } from "~/components/PageHeader";

export function meta() {
  return [{ title: "Cluster — Nginx Manager" }];
}

const NGINX_DIR = process.env.NGINX_DIR || "/data/nginx";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const nodes = db.select().from(clusterNodes).all();

  // Load config files and their sync tags
  let configFiles: string[] = [];
  try {
    configFiles = listConfigFiles(NGINX_DIR);
  } catch {
    // Nginx dir may not be accessible
  }

  const syncTags = db.select().from(configSyncTags).all();
  const syncTagMap: Record<string, string> = {};
  for (const tag of syncTags) {
    syncTagMap[tag.filePath] = tag.syncMode;
  }

  // Build file list with sync mode (default to "cluster-synced")
  const syncFiles = configFiles.map((filePath) => ({
    filePath,
    syncMode: syncTagMap[filePath] || "cluster-synced",
  }));

  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      name: n.name,
      url: n.url,
      apiKey: n.apiKey,
      role: n.role,
      status: n.status,
      lastSyncAt: n.lastSyncAt ? n.lastSyncAt.getTime() : null,
      lastError: n.lastError,
      createdAt: n.createdAt.getTime(),
    })),
    syncFiles,
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "add") {
    const name = (formData.get("name") as string)?.trim();
    const url = (formData.get("url") as string)?.trim();
    const apiKey = (formData.get("apiKey") as string)?.trim();
    const role = (formData.get("role") as string) || "worker";

    if (!name || !url || !apiKey) {
      return { error: "Name, URL, and API key are required" };
    }

    try {
      new URL(url);
    } catch {
      return { error: "Invalid URL format" };
    }

    const existing = db
      .select()
      .from(clusterNodes)
      .where(eq(clusterNodes.url, url))
      .get();
    if (existing) {
      return { error: "A node with this URL already exists" };
    }

    db.insert(clusterNodes)
      .values({
        name,
        url,
        apiKey,
        role: role as "controller" | "worker",
      })
      .run();

    return { ok: true, message: "Node added" };
  }

  if (intent === "delete") {
    const id = Number(formData.get("id"));
    db.delete(clusterNodes).where(eq(clusterNodes.id, id)).run();
    return { ok: true, message: "Node deleted" };
  }

  if (intent === "sync") {
    const id = Number(formData.get("id"));
    const result = await syncToNode(id);
    if (result.success) {
      return { ok: true, message: `Synced to ${result.nodeName}` };
    }
    return { error: `Sync failed: ${result.error}` };
  }

  if (intent === "sync-all") {
    const results = await syncToAllNodes();
    const failed = results.filter((r) => !r.success);
    if (failed.length === 0) {
      return { ok: true, message: `Synced to ${results.length} node(s)` };
    }
    return {
      error: `${failed.length}/${results.length} node(s) failed to sync`,
    };
  }

  if (intent === "set-sync-tag") {
    const filePath = (formData.get("filePath") as string)?.trim();
    const syncMode = formData.get("syncMode") as string;

    if (!filePath || !["cluster-synced", "local-only"].includes(syncMode)) {
      return { error: "Invalid file path or sync mode" };
    }

    // Upsert: try to find existing row, update or insert
    const existing = db
      .select()
      .from(configSyncTags)
      .where(eq(configSyncTags.filePath, filePath))
      .get();

    if (existing) {
      db.update(configSyncTags)
        .set({ syncMode: syncMode as "cluster-synced" | "local-only" })
        .where(eq(configSyncTags.filePath, filePath))
        .run();
    } else {
      db.insert(configSyncTags)
        .values({
          filePath,
          syncMode: syncMode as "cluster-synced" | "local-only",
        })
        .run();
    }

    return { ok: true, message: `Sync mode for ${filePath} set to ${syncMode}` };
  }

  return { error: "Unknown action" };
}

type NodeData = {
  id: number;
  name: string;
  url: string;
  apiKey: string;
  role: string;
  status: string;
  lastSyncAt: number | null;
  lastError: string | null;
  createdAt: number;
};

type SyncFileData = {
  filePath: string;
  syncMode: string;
};

export default function ClusterPage({ loaderData }: Route.ComponentProps) {
  const { nodes, syncFiles } = loaderData;
  const [showAddDialog, setShowAddDialog] = useState(false);
  const syncAllFetcher = useFetcher();
  const isSyncingAll = syncAllFetcher.state !== "idle";

  useEffect(() => {
    if (syncAllFetcher.data?.error) {
      toast.error(syncAllFetcher.data.error);
    } else if (syncAllFetcher.data?.ok) {
      toast.success(syncAllFetcher.data.message);
    }
  }, [syncAllFetcher.data]);

  return (
    <div>
      <PageHeader
        title="Cluster"
        description="Multi-node synchronization and management"
        actions={
          <>
            <syncAllFetcher.Form method="post">
              <input type="hidden" name="intent" value="sync-all" />
              <Button type="submit" variant="outline" disabled={isSyncingAll} className="press-effect">
                {isSyncingAll ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Sync All
              </Button>
            </syncAllFetcher.Form>
            <Button onClick={() => setShowAddDialog(true)} className="press-effect">
              <Plus className="mr-2 h-4 w-4" />
              Add Node
            </Button>
          </>
        }
      />

      {nodes.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          No cluster nodes configured. Add a worker node to get started.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Sync</TableHead>
                <TableHead className="w-[140px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {nodes.map((node) => (
                <NodeRow key={node.id} node={node} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Config Sync Tags Section */}
      <Card glass className="mt-8">
        <CardHeader>
          <CardTitle>Config Sync Tags</CardTitle>
          <CardDescription>
            Control which config files are synced to worker nodes. Files marked as
            &quot;local-only&quot; will never be pushed to workers during sync.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {syncFiles.length === 0 ? (
            <div className="rounded-md border p-6 text-center text-muted-foreground">
              No config files found.
            </div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Config File</TableHead>
                    <TableHead className="w-[180px]">Sync Mode</TableHead>
                    <TableHead className="w-[120px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {syncFiles.map((file) => (
                    <SyncTagRow key={file.filePath} file={file} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AddNodeDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
      />
    </div>
  );
}

function StatusBadge({ status, lastError }: { status: string; lastError: string | null }) {
  switch (status) {
    case "online":
      return (
        <Badge className="bg-green-600 hover:bg-green-700 text-white">
          online
        </Badge>
      );
    case "syncing":
      return (
        <Badge className="bg-blue-600 hover:bg-blue-700 text-white">
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          syncing
        </Badge>
      );
    case "error":
      return (
        <span className="inline-flex flex-col items-start gap-0.5">
          <Badge variant="destructive">error</Badge>
          {lastError && (
            <span className="text-xs text-destructive max-w-[200px] truncate" title={lastError}>
              {lastError}
            </span>
          )}
        </span>
      );
    case "offline":
    default:
      return <Badge variant="secondary">offline</Badge>;
  }
}

function RoleBadge({ role }: { role: string }) {
  if (role === "controller") {
    return <Badge>controller</Badge>;
  }
  return <Badge variant="secondary">worker</Badge>;
}

function SyncModeBadge({ mode }: { mode: string }) {
  if (mode === "local-only") {
    return (
      <Badge variant="secondary" className="gap-1">
        <Lock className="h-3 w-3" />
        local-only
      </Badge>
    );
  }
  return (
    <Badge className="bg-green-600 hover:bg-green-700 text-white gap-1">
      <Globe className="h-3 w-3" />
      cluster-synced
    </Badge>
  );
}

function SyncTagRow({ file }: { file: SyncFileData }) {
  const fetcher = useFetcher();
  const isUpdating = fetcher.state !== "idle";

  // Use optimistic value while the request is in flight
  const optimisticMode =
    fetcher.formData?.get("syncMode")?.toString() || file.syncMode;

  const toggleMode = () => {
    const newMode =
      optimisticMode === "cluster-synced" ? "local-only" : "cluster-synced";
    fetcher.submit(
      {
        intent: "set-sync-tag",
        filePath: file.filePath,
        syncMode: newMode,
      },
      { method: "post" }
    );
  };

  useEffect(() => {
    if (fetcher.data?.error) {
      toast.error(fetcher.data.error);
    } else if (fetcher.data?.ok) {
      toast.success(fetcher.data.message);
    }
  }, [fetcher.data]);

  return (
    <TableRow className="hover:bg-muted/30 transition-colors">
      <TableCell className="font-mono text-sm max-w-[400px] truncate" title={file.filePath}>
        {file.filePath}
      </TableCell>
      <TableCell>
        <SyncModeBadge mode={optimisticMode} />
      </TableCell>
      <TableCell>
        <Button
          variant="outline"
          size="sm"
          onClick={toggleMode}
          disabled={isUpdating}
        >
          {isUpdating ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : null}
          {optimisticMode === "cluster-synced" ? "Set Local" : "Set Synced"}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function NodeRow({ node }: { node: NodeData }) {
  const syncFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const [showConfirm, setShowConfirm] = useState(false);
  const isSyncing = syncFetcher.state !== "idle";

  useEffect(() => {
    if (syncFetcher.data?.error) {
      toast.error(syncFetcher.data.error);
    } else if (syncFetcher.data?.ok) {
      toast.success(syncFetcher.data.message);
    }
  }, [syncFetcher.data]);

  useEffect(() => {
    if (deleteFetcher.data?.error) {
      toast.error(deleteFetcher.data.error);
    } else if (deleteFetcher.data?.ok) {
      toast.success(deleteFetcher.data.message);
    }
  }, [deleteFetcher.data]);

  return (
    <TableRow className="hover:bg-muted/30 transition-colors">
      <TableCell className="font-medium">{node.name}</TableCell>
      <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">
        {node.url}
      </TableCell>
      <TableCell>
        <RoleBadge role={node.role} />
      </TableCell>
      <TableCell>
        <StatusBadge status={node.status} lastError={node.lastError} />
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {node.lastSyncAt
          ? new Date(node.lastSyncAt).toLocaleString()
          : "Never"}
      </TableCell>
      <TableCell>
        <div className="flex gap-1">
          <syncFetcher.Form method="post">
            <input type="hidden" name="intent" value="sync" />
            <input type="hidden" name="id" value={String(node.id)} />
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              disabled={isSyncing}
              title="Sync to this node"
            >
              {isSyncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </syncFetcher.Form>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowConfirm(true)}
            title="Delete node"
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>

        <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm Delete</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to remove node &quot;{node.name}&quot; from the cluster?
                This will not affect the remote server.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  deleteFetcher.submit(
                    { intent: "delete", id: String(node.id) },
                    { method: "post" }
                  );
                  setShowConfirm(false);
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}

function AddNodeDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = (form.elements.namedItem("name") as HTMLInputElement).value.trim();
    const url = (form.elements.namedItem("url") as HTMLInputElement).value.trim();
    const apiKey = (form.elements.namedItem("apiKey") as HTMLInputElement).value.trim();

    if (!name) {
      toast.error("Name is required");
      return;
    }
    if (!url) {
      toast.error("URL is required");
      return;
    }
    if (!apiKey) {
      toast.error("API key is required");
      return;
    }

    try {
      new URL(url);
    } catch {
      toast.error("Invalid URL format");
      return;
    }

    fetcher.submit(new FormData(form), { method: "post" });
  };

  useEffect(() => {
    if (fetcher.data?.error) {
      toast.error(fetcher.data.error);
    } else if (fetcher.data?.ok) {
      toast.success(fetcher.data.message);
      onClose();
    }
  }, [fetcher.data]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Cluster Node</DialogTitle>
        </DialogHeader>
        <form method="post" onSubmit={handleSubmit}>
          <input type="hidden" name="intent" value="add" />

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="node-name">Name</Label>
              <Input
                id="node-name"
                name="name"
                type="text"
                required
                placeholder="worker-1"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="node-url">URL</Label>
              <Input
                id="node-url"
                name="url"
                type="url"
                required
                placeholder="https://worker1.example.com"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="node-apiKey">API Key</Label>
              <Input
                id="node-apiKey"
                name="apiKey"
                type="password"
                required
                placeholder="Shared secret for authentication"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="node-role">Role</Label>
              <select
                id="node-role"
                name="role"
                defaultValue="worker"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="worker">Worker</option>
                <option value="controller">Controller</option>
              </select>
            </div>
          </div>

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting} className="press-effect">
              {isSubmitting ? "Adding..." : "Add Node"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
