import type { Route } from "./+types/index";
import { Link, useFetcher } from "react-router";
import { db } from "~/lib/db/connection";
import { hosts, hostGroups, hostLabels, hostLabelAssignments } from "~/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { useState, useMemo } from "react";
import { logAudit } from "~/lib/audit/log";
import { getSessionUser } from "~/lib/auth/session.server";
import { requireEditor } from "~/lib/auth/middleware";
import { generateAllConfigs } from "~/lib/nginx/generator";
import { reloadNginx } from "~/lib/nginx/reload";
import Fuse from "fuse.js";
import { PageHeader } from "~/components/PageHeader";
import { GroupsModal, type GroupItem } from "~/components/GroupsModal";
import { LabelsModal, getLabelColorClass, type LabelItem } from "~/components/LabelsModal";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Power,
  Search,
  FolderOpen,
  List,
  Tags,
  Settings2,
} from "lucide-react";

export function meta() {
  return [{ title: "Hosts — Nginx Manager" }];
}

// ─── Loader ─────────────────────────────────────────────────

export async function loader({}: Route.LoaderArgs) {
  const allHosts = db.select().from(hosts).all();
  const allGroups = db.select().from(hostGroups).all();
  const allLabels = db.select().from(hostLabels).all();
  const allAssignments = db.select().from(hostLabelAssignments).all();

  const hostCounts = db
    .select({
      groupId: hosts.groupId,
      count: sql<number>`count(*)`,
    })
    .from(hosts)
    .groupBy(hosts.groupId)
    .all();

  const countMap = new Map(hostCounts.map((h) => [h.groupId, h.count]));

  const groupsWithCounts: GroupItem[] = allGroups.map((g) => ({
    ...g,
    hostCount: countMap.get(g.id) ?? 0,
  }));

  return {
    hosts: allHosts,
    groups: groupsWithCounts,
    labels: allLabels,
    assignments: allAssignments,
  };
}

// ─── Action ─────────────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  await requireEditor(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const user = await getSessionUser(request);
  const ipAddress =
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    "unknown";

  // ── Host actions ──────────────────────────────────────────
  if (intent === "toggle") {
    const id = Number(formData.get("id"));
    const host = db.select().from(hosts).where(eq(hosts.id, id)).get();
    if (host) {
      db.update(hosts)
        .set({ enabled: !host.enabled, updatedAt: new Date() })
        .where(eq(hosts.id, id))
        .run();
      logAudit({
        userId: user?.userId ?? null,
        action: "update",
        entity: "host",
        entityId: id,
        details: { enabled: !host.enabled },
        ipAddress,
      });
      generateAllConfigs();
      reloadNginx();
    }
  } else if (intent === "delete") {
    const id = Number(formData.get("id"));
    db.delete(hosts).where(eq(hosts.id, id)).run();
    logAudit({
      userId: user?.userId ?? null,
      action: "delete",
      entity: "host",
      entityId: id,
      ipAddress,
    });
    generateAllConfigs();
    reloadNginx();
  }

  // ── Group actions ─────────────────────────────────────────
  else if (intent === "createGroup") {
    const name = formData.get("name") as string;
    const description = (formData.get("description") as string) || null;
    const webhookUrl = (formData.get("webhookUrl") as string) || null;
    if (!name) return { error: "Name is required" };
    if (webhookUrl && !/^https?:\/\/.+/.test(webhookUrl)) {
      return { error: "Webhook URL must be a valid HTTP/HTTPS URL" };
    }
    const result = db
      .insert(hostGroups)
      .values({ name, description, webhookUrl, createdAt: new Date() })
      .returning()
      .get();
    logAudit({
      userId: user?.userId ?? null,
      action: "create",
      entity: "group",
      entityId: result.id,
      details: { name },
      ipAddress,
    });
    return { ok: true };
  } else if (intent === "updateGroup") {
    const id = Number(formData.get("id"));
    const name = formData.get("name") as string;
    const description = (formData.get("description") as string) || null;
    const webhookUrl = (formData.get("webhookUrl") as string) || null;
    if (!name) return { error: "Name is required" };
    if (webhookUrl && !/^https?:\/\/.+/.test(webhookUrl)) {
      return { error: "Webhook URL must be a valid HTTP/HTTPS URL" };
    }
    db.update(hostGroups)
      .set({ name, description, webhookUrl })
      .where(eq(hostGroups.id, id))
      .run();
    logAudit({
      userId: user?.userId ?? null,
      action: "update",
      entity: "group",
      entityId: id,
      details: { name },
      ipAddress,
    });
    return { ok: true };
  } else if (intent === "deleteGroup") {
    const id = Number(formData.get("id"));
    db.delete(hostGroups).where(eq(hostGroups.id, id)).run();
    logAudit({
      userId: user?.userId ?? null,
      action: "delete",
      entity: "group",
      entityId: id,
      ipAddress,
    });
    return { ok: true };
  }

  // ── Label actions ─────────────────────────────────────────
  else if (intent === "createLabel") {
    const name = formData.get("name") as string;
    const color = (formData.get("color") as string) || "green";
    if (!name) return { error: "Label name is required" };
    const result = db
      .insert(hostLabels)
      .values({ name, color, createdAt: new Date() })
      .returning()
      .get();
    logAudit({
      userId: user?.userId ?? null,
      action: "create",
      entity: "label",
      entityId: result.id,
      details: { name, color },
      ipAddress,
    });
    return { ok: true };
  } else if (intent === "updateLabel") {
    const id = Number(formData.get("id"));
    const name = formData.get("name") as string;
    const color = (formData.get("color") as string) || "green";
    if (!name) return { error: "Label name is required" };
    db.update(hostLabels)
      .set({ name, color })
      .where(eq(hostLabels.id, id))
      .run();
    logAudit({
      userId: user?.userId ?? null,
      action: "update",
      entity: "label",
      entityId: id,
      details: { name, color },
      ipAddress,
    });
    return { ok: true };
  } else if (intent === "deleteLabel") {
    const id = Number(formData.get("id"));
    db.delete(hostLabels).where(eq(hostLabels.id, id)).run();
    logAudit({
      userId: user?.userId ?? null,
      action: "delete",
      entity: "label",
      entityId: id,
      ipAddress,
    });
    return { ok: true };
  }

  return { ok: true };
}

// ─── Types ──────────────────────────────────────────────────

type HostRecord = typeof hosts.$inferSelect;
type AssignmentRecord = typeof hostLabelAssignments.$inferSelect;

interface HostWithLabels extends HostRecord {
  hostLabels: LabelItem[];
}

// ─── Component ──────────────────────────────────────────────

export default function HostsIndex({ loaderData }: Route.ComponentProps) {
  const { hosts: allHosts, groups, labels, assignments } = loaderData;
  const [viewMode, setViewMode] = useState<"groups" | "all">("groups");
  const [search, setSearch] = useState("");
  const [groupsModalOpen, setGroupsModalOpen] = useState(false);
  const [labelsModalOpen, setLabelsModalOpen] = useState(false);

  // Build label map: hostId -> LabelItem[]
  const labelMap = useMemo(() => {
    const labelsById = new Map(labels.map((l) => [l.id, l]));
    const map = new Map<number, LabelItem[]>();
    for (const a of assignments) {
      const label = labelsById.get(a.labelId);
      if (label) {
        const existing = map.get(a.hostId) ?? [];
        existing.push(label);
        map.set(a.hostId, existing);
      }
    }
    return map;
  }, [labels, assignments]);

  // Build group map
  const groupMap = useMemo(
    () => new Map(groups.map((g) => [g.id, g])),
    [groups]
  );

  // Enrich hosts with labels
  const hostsWithLabels: HostWithLabels[] = useMemo(
    () =>
      allHosts.map((h) => ({
        ...h,
        hostLabels: labelMap.get(h.id) ?? [],
      })),
    [allHosts, labelMap]
  );

  // Fuse.js fuzzy search
  const fuse = useMemo(
    () =>
      new Fuse(hostsWithLabels, {
        keys: [
          "domains",
          "hostLabels.name",
          { name: "groupName", getFn: (h) => (h.groupId ? groupMap.get(h.groupId)?.name ?? "" : "") },
        ],
        threshold: 0.3,
      }),
    [hostsWithLabels, groupMap]
  );

  const filteredHosts = useMemo(() => {
    if (!search.trim()) return hostsWithLabels;
    return fuse.search(search).map((r) => r.item);
  }, [search, hostsWithLabels, fuse]);

  return (
    <div className="space-y-6">
      {/* ── Header ────────────────────────────────────────────── */}
      <PageHeader
        title="Proxy Hosts"
        description="Manage your reverse proxy hosts and routing rules"
        actions={
          <Button asChild className="press-effect">
            <Link to="/admin/hosts/new">
              <Plus className="mr-2 h-4 w-4" />
              Add Host
            </Link>
          </Button>
        }
      />

      {/* ── Toolbar ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search hosts..."
            className="pl-9"
          />
        </div>

        <div className="flex-1" />

        <div className="flex rounded-md border">
          <Button
            variant={viewMode === "groups" ? "default" : "ghost"}
            size="sm"
            className="rounded-r-none"
            onClick={() => setViewMode("groups")}
          >
            <FolderOpen className="mr-1.5 h-4 w-4" />
            Groups
          </Button>
          <Button
            variant={viewMode === "all" ? "default" : "ghost"}
            size="sm"
            className="rounded-l-none"
            onClick={() => setViewMode("all")}
          >
            <List className="mr-1.5 h-4 w-4" />
            All
          </Button>
        </div>

        <Button variant="outline" size="sm" onClick={() => setGroupsModalOpen(true)}>
          <Settings2 className="mr-1.5 h-4 w-4" />
          Manage Groups
        </Button>

        <Button variant="outline" size="sm" onClick={() => setLabelsModalOpen(true)}>
          <Tags className="mr-1.5 h-4 w-4" />
          Manage Labels
        </Button>
      </div>

      {/* ── Content ───────────────────────────────────────────── */}
      {filteredHosts.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          {search.trim()
            ? "No hosts match your search."
            : "No hosts configured yet."}
        </div>
      ) : viewMode === "all" ? (
        <AllHostsTable hosts={filteredHosts} groupMap={groupMap} />
      ) : (
        <GroupedHostsView
          hosts={filteredHosts}
          groups={groups}
          groupMap={groupMap}
        />
      )}

      {/* ── Modals ────────────────────────────────────────────── */}
      <GroupsModal
        open={groupsModalOpen}
        onClose={() => setGroupsModalOpen(false)}
        groups={groups}
        actionUrl="/admin/hosts"
      />
      <LabelsModal
        open={labelsModalOpen}
        onClose={() => setLabelsModalOpen(false)}
        labels={labels}
        actionUrl="/admin/hosts"
      />
    </div>
  );
}

// ─── All Hosts Table ────────────────────────────────────────

function AllHostsTable({
  hosts: hostsList,
  groupMap,
}: {
  hosts: HostWithLabels[];
  groupMap: Map<number, GroupItem>;
}) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Domains</TableHead>
            <TableHead>Labels</TableHead>
            <TableHead>Info</TableHead>
            <TableHead>SSL</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-[70px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {hostsList.map((host) => (
            <HostRow key={host.id} host={host} groupMap={groupMap} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ─── Grouped Hosts View ─────────────────────────────────────

function GroupedHostsView({
  hosts: hostsList,
  groups,
  groupMap,
}: {
  hosts: HostWithLabels[];
  groups: GroupItem[];
  groupMap: Map<number, GroupItem>;
}) {
  // Bucket hosts by group
  const grouped = useMemo(() => {
    const buckets = new Map<number | null, HostWithLabels[]>();
    for (const host of hostsList) {
      const key = host.groupId ?? null;
      const existing = buckets.get(key) ?? [];
      existing.push(host);
      buckets.set(key, existing);
    }
    return buckets;
  }, [hostsList]);

  // Ordered: named groups first, then ungrouped
  const orderedGroups = useMemo(() => {
    const result: Array<{ id: number | null; name: string; hosts: HostWithLabels[] }> = [];
    for (const group of groups) {
      const groupHosts = grouped.get(group.id);
      if (groupHosts && groupHosts.length > 0) {
        result.push({ id: group.id, name: group.name, hosts: groupHosts });
      }
    }
    const ungrouped = grouped.get(null);
    if (ungrouped && ungrouped.length > 0) {
      result.push({ id: null, name: "Ungrouped", hosts: ungrouped });
    }
    return result;
  }, [groups, grouped]);

  if (orderedGroups.length === 0) {
    return (
      <div className="rounded-md border p-8 text-center text-muted-foreground">
        No hosts to display.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {orderedGroups.map((section) => (
        <div key={section.id ?? "ungrouped"} className="space-y-2">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-lg font-medium">{section.name}</h2>
            <Badge variant="secondary" className="text-xs">
              {section.hosts.length}
            </Badge>
          </div>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Domains</TableHead>
                  <TableHead>Labels</TableHead>
                  <TableHead>Info</TableHead>
                  <TableHead>SSL</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-[70px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {section.hosts.map((host) => (
                  <HostRow key={host.id} host={host} groupMap={groupMap} />
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Host Row ───────────────────────────────────────────────

function HostRow({
  host,
  groupMap,
}: {
  host: HostWithLabels;
  groupMap: Map<number, GroupItem>;
}) {
  const toggleFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const [alertOpen, setAlertOpen] = useState(false);

  const domains = host.domains as string[];

  const handleToggle = () => {
    toggleFetcher.submit(
      { intent: "toggle", id: String(host.id) },
      { method: "post" }
    );
  };

  const handleDelete = () => {
    deleteFetcher.submit(
      { intent: "delete", id: String(host.id) },
      { method: "post" }
    );
    setAlertOpen(false);
  };

  // Type badge
  const typeBadge = getHostTypeBadge(host);

  // SSL display
  const sslLabel =
    host.sslType === "letsencrypt"
      ? "Let's Encrypt"
      : host.sslType === "custom"
        ? "Custom"
        : "None";
  const sslVariant =
    host.sslType === "letsencrypt"
      ? "default"
      : host.sslType === "custom"
        ? "secondary"
        : "outline";

  // Info derived from locations/streams
  const typeInfo = getHostInfo(host);

  return (
    <TableRow className="hover:bg-muted/30 transition-colors">
      {/* Type */}
      <TableCell>{typeBadge}</TableCell>

      {/* Domains */}
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {domains.slice(0, 3).map((d, i) => (
            <Badge key={i} variant="secondary">
              {d}
            </Badge>
          ))}
          {domains.length > 3 && (
            <Badge variant="outline">+{domains.length - 3} more</Badge>
          )}
        </div>
      </TableCell>

      {/* Labels */}
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {host.hostLabels.map((label) => (
            <span
              key={label.id}
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getLabelColorClass(label.color)}`}
            >
              {label.name}
            </span>
          ))}
        </div>
      </TableCell>

      {/* Type-specific info */}
      <TableCell className="text-sm text-muted-foreground">
        {typeInfo}
      </TableCell>

      {/* SSL */}
      <TableCell>
        <Badge variant={sslVariant as "default" | "secondary" | "outline"}>
          {sslLabel}
        </Badge>
      </TableCell>

      {/* Status */}
      <TableCell>
        <Badge variant={host.enabled ? "default" : "secondary"}>
          {host.enabled ? "Enabled" : "Disabled"}
        </Badge>
      </TableCell>

      {/* Actions */}
      <TableCell>
        <AlertDialog open={alertOpen} onOpenChange={setAlertOpen}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">Open menu</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link to={`/admin/hosts/${host.id}/edit`}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleToggle}
                disabled={toggleFetcher.state !== "idle"}
              >
                <Power className="mr-2 h-4 w-4" />
                {host.enabled ? "Disable" : "Enable"}
              </DropdownMenuItem>
              <AlertDialogTrigger asChild>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={deleteFetcher.state !== "idle"}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </AlertDialogTrigger>
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm Delete</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete this host? This action cannot be
                undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
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

// ─── Helpers ────────────────────────────────────────────────

function getHostTypeBadge(host: HostRecord) {
  const locationTypes = new Set((host.locations as any[] ?? []).map((l: any) => l.type));
  const hasStreams = (host.streamPorts as any[] ?? []).length > 0;

  if (locationTypes.size === 0 && hasStreams) {
    return (
      <Badge
        variant="secondary"
        className="bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
      >
        Stream
      </Badge>
    );
  }
  if (locationTypes.size === 1 && !hasStreams) {
    const type = [...locationTypes][0];
    if (type === "proxy") return <Badge>Proxy</Badge>;
    if (type === "static") return <Badge variant="secondary">Static</Badge>;
    if (type === "file") return <Badge variant="secondary">File</Badge>;
    if (type === "redirect") return <Badge variant="outline">Redirect</Badge>;
  }
  return <Badge variant="outline">Mixed</Badge>;
}

function getHostInfo(host: HostRecord) {
  const locations = (host.locations as any[] ?? []);
  const streams = (host.streamPorts as any[] ?? []);

  if (locations.length === 1 && streams.length === 0) {
    const loc = locations[0];
    if (loc.type === "proxy" && loc.upstreams?.length > 0) {
      const u = loc.upstreams[0];
      return `\u2192 ${u.server}:${u.port}`;
    }
    if (loc.type === "static") return `Static: ${loc.staticDir || "-"}`;
    if (loc.type === "file") return `File: ${loc.staticDir || "-"}`;
    if (loc.type === "redirect") return `\u2192 ${loc.forwardScheme}://${loc.forwardDomain}${loc.forwardPath}`;
  }

  const parts = [];
  if (locations.length > 0) parts.push(`${locations.length} location${locations.length > 1 ? "s" : ""}`);
  if (streams.length > 0) parts.push(`${streams.length} stream${streams.length > 1 ? "s" : ""}`);
  return parts.join(" + ") || "-";
}
