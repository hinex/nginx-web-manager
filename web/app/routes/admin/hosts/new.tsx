import type { Route } from "./+types/new";
import { redirect } from "react-router";
import { db } from "~/lib/db/connection";
import { hosts, hostGroups, hostLabels, hostLabelAssignments, accessLists } from "~/lib/db/schema";
import { HostForm, type HostFormData } from "~/components/host-form/HostForm";
import { PageHeader } from "~/components/PageHeader";
import { logAudit } from "~/lib/audit/log";
import { getSessionUser } from "~/lib/auth/session.server";
import { generateAllConfigs } from "~/lib/nginx/generator";
import { reloadNginx } from "~/lib/nginx/reload";
import { validateNginxConfig } from "~/lib/nginx/validator";

export function meta() {
  return [{ title: "Add Host — Nginx Manager" }];
}

export async function loader({}: Route.LoaderArgs) {
  const groups = db.select().from(hostGroups).all();
  const labels = db.select().from(hostLabels).all();
  const allAccessLists = db.select().from(accessLists).all();
  return { groups, labels, accessLists: allAccessLists };
}

export async function action({ request }: Route.ActionArgs) {
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

  const result = db.insert(hosts)
    .values({
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
      locations: data.locations as any,
      streamPorts: data.streamPorts as any,
      webhookUrl: data.webhookUrl || undefined,
      advancedNginx: data.advancedNginx || undefined,
      clientMaxBodySize: data.clientMaxBodySize || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .get();

  // Save label assignments
  if (data.labelIds && data.labelIds.length > 0) {
    for (const labelId of data.labelIds) {
      db.insert(hostLabelAssignments)
        .values({ hostId: result.id, labelId })
        .run();
    }
  }

  const user = await getSessionUser(request);
  logAudit({
    userId: user?.userId ?? null,
    action: "create",
    entity: "host",
    entityId: result.id,
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

export default function NewHost({ loaderData }: Route.ComponentProps) {
  const { groups, labels, accessLists: allAccessLists } = loaderData;

  return (
    <div>
      <PageHeader
        title="Add Host"
        description="Configure a new reverse proxy host"
      />
      <HostForm
        groups={groups}
        labels={labels}
        accessLists={allAccessLists}
        submitLabel="Create Host"
      />
    </div>
  );
}
