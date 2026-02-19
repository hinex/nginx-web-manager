import type { Route } from "./+types/edit";
import { redirect } from "react-router";
import { db } from "~/lib/db/connection";
import { hosts, hostGroups, hostLabels, hostLabelAssignments, accessLists } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { HostForm, type HostFormData } from "~/components/host-form/HostForm";
import { PageHeader } from "~/components/PageHeader";
import { logAudit } from "~/lib/audit/log";
import { getSessionUser } from "~/lib/auth/session.server";
import { generateAllConfigs } from "~/lib/nginx/generator";
import { reloadNginx } from "~/lib/nginx/reload";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { hashBasicAuthPasswords } from "~/lib/auth/hash-basic-auth";

export function meta() {
  return [{ title: "Edit Host — Nginx Manager" }];
}

export async function loader({ params }: Route.LoaderArgs) {
  const id = Number(params.id);
  const host = db.select().from(hosts).where(eq(hosts.id, id)).get();

  if (!host) {
    throw new Response("Host not found", { status: 404 });
  }

  const groups = db.select().from(hostGroups).all();
  const labels = db.select().from(hostLabels).all();
  const allAccessLists = db.select().from(accessLists).all();
  const assignments = db
    .select()
    .from(hostLabelAssignments)
    .where(eq(hostLabelAssignments.hostId, id))
    .all();

  return {
    host,
    groups,
    labels,
    accessLists: allAccessLists,
    assignedLabelIds: assignments.map((a) => a.labelId),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const id = Number(params.id);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // Handle inline group creation
  if (intent === "createGroup") {
    const name = formData.get("name") as string;
    if (!name?.trim()) return { error: "Group name is required" };
    const result = db
      .insert(hostGroups)
      .values({ name: name.trim(), createdAt: new Date() })
      .returning()
      .get();
    return { groupId: result.id };
  }

  // Handle inline label creation
  if (intent === "createLabel") {
    const name = formData.get("name") as string;
    const color = formData.get("color") as string || "green";
    if (!name?.trim()) return { error: "Label name is required" };
    const result = db
      .insert(hostLabels)
      .values({ name: name.trim(), color, createdAt: new Date() })
      .returning()
      .get();
    return { labelId: result.id, labelName: result.name, labelColor: result.color };
  }

  let data: HostFormData;
  try {
    data = JSON.parse(formData.get("formData") as string);
  } catch {
    return { error: "Invalid form data" };
  }

  // Validation
  const hasHttpLocations = data.locations.length > 0;
  if (hasHttpLocations && (!data.domains || data.domains.length === 0)) {
    return { error: "At least one domain is required for HTTP locations" };
  }

  if (data.locations.length === 0 && data.streamPorts.length === 0) {
    return { error: "At least one location or stream port is required" };
  }

  // Validate no duplicate location paths
  const locationKeys = data.locations.map((l) => {
    const prefix = l.matchType === "exact" ? "= " : l.matchType === "regex" ? "~ " : "";
    return `${prefix}${l.path}`;
  });
  const seen = new Set<string>();
  for (const key of locationKeys) {
    if (seen.has(key)) {
      return { error: `Duplicate location "${key}". Each location path + match type must be unique.` };
    }
    seen.add(key);
  }

  for (const loc of data.locations) {
    if (loc.type === "proxy") {
      if (!loc.upstreams || loc.upstreams.length === 0) {
        return { error: `Proxy location "${loc.path}" needs at least one upstream` };
      }
      for (const u of loc.upstreams) {
        if (!u.server?.trim()) return { error: "All upstreams must have a server address" };
        if (!u.port || u.port < 1 || u.port > 65535) return { error: "Upstream port must be 1-65535" };
      }
      // Validate all upstreams in a location use the same protocol
      const protocols = new Set(loc.upstreams.map((u: any) => u.protocol || "http"));
      if (protocols.size > 1) {
        return { error: `Proxy location "${loc.path}" has mixed upstream protocols. All upstreams in a location must use the same protocol.` };
      }
    }
    if (loc.type === "static") {
      if (!loc.staticDir?.trim()) return { error: `Static location "${loc.path}" needs a directory path` };
    }
    if (loc.type === "redirect") {
      if (!loc.forwardDomain?.trim()) return { error: `Redirect location "${loc.path}" needs a forward domain` };
    }
    if (loc.type === "file") {
      if (!loc.staticDir?.trim()) return { error: `File location "${loc.path}" needs a file path` };
    }
  }

  for (const sp of data.streamPorts) {
    if (!sp.port || sp.port < 1 || sp.port > 65535) {
      return { error: "Stream port must be 1-65535" };
    }
    if (!sp.upstreams || sp.upstreams.length === 0) {
      return { error: `Stream port ${sp.port} needs at least one upstream` };
    }
  }

  if (data.sslType === "custom" && (!data.sslCertPath || !data.sslKeyPath)) {
    return { error: "Custom SSL requires both certificate and key paths" };
  }

  // Load existing host for password preservation
  const existingHost = db.select().from(hosts).where(eq(hosts.id, id)).get();
  const existingBasicAuth = (existingHost as any)?.basicAuth ?? null;
  const existingLocations = (existingHost?.locations as any[]) ?? [];
  const hashed = await hashBasicAuthPasswords(data.basicAuth, data.locations, existingBasicAuth, existingLocations);

  db.update(hosts)
    .set({
      domains: data.domains,
      groupId: data.groupId,
      enabled: data.enabled,
      sslType: data.sslType as any,
      sslForceHttps: data.sslForceHttps,
      sslCertPath: data.sslCertPath || undefined,
      sslKeyPath: data.sslKeyPath || undefined,
      hsts: data.hsts,
      http2: data.http2,
      compression: data.compression,
      redirectWww: data.redirectWww ?? false,
      locations: hashed.locations as any,
      basicAuth: hashed.basicAuth as any,
      streamPorts: data.streamPorts as any,
      webhookUrl: data.webhookUrl || undefined,
      advancedNginx: data.advancedNginx || undefined,
      clientMaxBodySize: data.clientMaxBodySize || undefined,
      updatedAt: new Date(),
    })
    .where(eq(hosts.id, id))
    .run();

  // Sync label assignments: delete old, insert new
  db.delete(hostLabelAssignments)
    .where(eq(hostLabelAssignments.hostId, id))
    .run();
  if (data.labelIds && data.labelIds.length > 0) {
    for (const labelId of data.labelIds) {
      db.insert(hostLabelAssignments)
        .values({ hostId: id, labelId })
        .run();
    }
  }

  const user = await getSessionUser(request);
  logAudit({
    userId: user?.userId ?? null,
    action: "update",
    entity: "host",
    entityId: id,
    details: { domains: data.domains },
    ipAddress: request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown",
  });

  generateAllConfigs();

  const validation = validateNginxConfig();
  if (!validation.valid) {
    return { error: `Nginx config validation failed: ${validation.error}` };
  }

  reloadNginx();

  return redirect("/admin/hosts");
}

export default function EditHost({ loaderData }: Route.ComponentProps) {
  const { host, groups, labels, accessLists: allAccessLists, assignedLabelIds } = loaderData;

  const initialData: Partial<HostFormData> = {
    domains: host.domains as string[],
    groupId: host.groupId,
    enabled: host.enabled,
    labelIds: assignedLabelIds,
    sslType: host.sslType,
    sslCertPath: host.sslCertPath || "",
    sslKeyPath: host.sslKeyPath || "",
    sslForceHttps: host.sslForceHttps,
    hsts: host.hsts,
    http2: host.http2,
    compression: host.compression,
    redirectWww: host.redirectWww,
    locations: host.locations as any ?? [],
    basicAuth: (host as any).basicAuth
      ? {
          ...(host as any).basicAuth,
          users: ((host as any).basicAuth.users ?? []).map((u: any) => ({
            username: u.username,
            password: "", // don't expose hash to client
          })),
        }
      : null,
    streamPorts: host.streamPorts as any ?? [],
    webhookUrl: host.webhookUrl || "",
    advancedNginx: host.advancedNginx || "",
    clientMaxBodySize: host.clientMaxBodySize || "",
  };

  return (
    <div>
      <PageHeader
        title="Edit Host"
        description="Update proxy host configuration"
        backHref="/admin/hosts"
      />
      <HostForm
        initialData={initialData}
        groups={groups}
        labels={labels}
        accessLists={allAccessLists}
        submitLabel="Update Host"
      />
    </div>
  );
}
