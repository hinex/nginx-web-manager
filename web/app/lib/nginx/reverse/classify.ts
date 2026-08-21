import type { AstDelta, DirectiveRef } from "./match";
import type { HostConfig } from "~/lib/nginx/templates/server-block";
import { parse as parseAst } from "~/lib/nginx/parser/ast";
import { render } from "~/lib/nginx/parser/renderer";

type Location = HostConfig["locations"][number];

export type ClassifiedEdit =
  | { kind: "field"; field: string; from: unknown; to: unknown; label: string }
  | { kind: "location-field"; index: number; field: string; from: unknown; to: unknown; label: string }
  | { kind: "location-advanced"; index: number; text: string; label: string }
  // NOTE: `type` is not in the plan's literal interface (design record line ~464)
  // but the core-detection algorithm it describes (proxy/static/redirect/advanced)
  // has nowhere else to land. Added here; see NUANCES.md #15.
  | { kind: "location-added"; path: string; matchType: string; type: string; body: string; label: string }
  | { kind: "location-removed"; index: number; label: string; losing: string[] }
  | { kind: "server-advanced"; text: string; label: string }
  | { kind: "prelude"; text: string; label: string };

export interface Refusal {
  line: number;
  directive: string;
  reason: string;
}

export interface Classification {
  edits: ClassifiedEdit[];
  refusals: Refusal[];
}

const REASON_GLOBAL_SETTINGS = "resolver and set $backend_* come from global settings, not from this host";
const REASON_ACME = "Certificate paths are managed by the ACME client; change them in the host's SSL tab";
const REASON_LISTEN_443 = "Turn SSL off in the host's SSL tab instead of deleting the listen directive";
const REASON_UPSTREAM_RENAME = "This upstream name is an internal link identifier and cannot be renamed";
const REASON_SECOND_SERVER = "A second server block cannot be represented in the host model";
const REASON_AMBIGUOUS_LOCATIONS = "Two or more locations changed at once and cannot be matched to model entries";
const REASON_UNMAPPABLE_REMOVAL =
  "Deleting this line cannot be mapped back to a host field — revert the line, or make the change in the host form";

// ── parseLocationScope / core-detection — exported for Task 6 reuse ──

/**
 * Inverse of `buildLocationDirective` (server-block.ts:358): turns a scope
 * string like "location = /api" back into { path, matchType }.
 */
export function parseLocationScope(scope: string): { path: string; matchType: string } {
  const rest = scope.replace(/^location\s+/, "");
  if (rest.startsWith("= ")) return { path: rest.slice(2), matchType: "exact" };
  if (rest.startsWith("~ ")) return { path: rest.slice(2), matchType: "regex" };
  return { path: rest, matchType: "prefix" };
}

function locationScopeFor(loc: Location): string {
  switch (loc.matchType) {
    case "exact":
      return `location = ${loc.path}`;
    case "regex":
      return `location ~ ${loc.path}`;
    default:
      return `location ${loc.path}`;
  }
}

function refIdentityKey(ref: DirectiveRef): string {
  return `${ref.name} ${ref.args.join(" ")}`.trim();
}

function findLocationIndex(host: HostConfig, scope: string): number {
  return (host.locations ?? []).findIndex((loc) => locationScopeFor(loc) === scope);
}

/**
 * Core-detection for an added location block, per design record: proxy_pass
 * → proxy; alias/root → static; return with a 3xx first arg → redirect;
 * otherwise → advanced (whole body kept as raw text).
 */
export function detectLocationCore(blockText: string): { type: string; body: string } {
  const parsed = parseAst(blockText);
  const loc = parsed.directives[0];
  const inner = loc?.block?.directives ?? [];
  const body = render({ directives: inner.map((d) => ({ ...d, comments: undefined })) }).trim();

  if (inner.some((d) => d.name === "proxy_pass")) return { type: "proxy", body };
  if (inner.some((d) => d.name === "alias" || d.name === "root")) return { type: "static", body };
  const ret = inner.find((d) => d.name === "return");
  if (ret && /^3\d\d$/.test(ret.args[0] ?? "")) return { type: "redirect", body };
  return { type: "advanced", body };
}

// ── Refusal predicates (design record §refusals 1-4) ──

function certRefusal(ref: DirectiveRef, host: HostConfig): Refusal | null {
  if ((ref.name === "ssl_certificate" || ref.name === "ssl_certificate_key") && host.sslType === "letsencrypt") {
    return { line: ref.line, directive: ref.name, reason: REASON_ACME };
  }
  return null;
}

function globalSettingsRefusal(ref: DirectiveRef): Refusal | null {
  if (ref.name === "resolver") {
    return { line: ref.line, directive: ref.name, reason: REASON_GLOBAL_SETTINGS };
  }
  if (ref.name === "set" && /^\$backend_/.test(ref.args[0] ?? "")) {
    return { line: ref.line, directive: ref.name, reason: REASON_GLOBAL_SETTINGS };
  }
  return null;
}

function listen443Refusal(ref: DirectiveRef): Refusal | null {
  if (ref.name === "listen") {
    const joined = ref.args.join(" ");
    if (joined.includes("443") && joined.includes("ssl")) {
      return { line: ref.line, directive: "listen", reason: REASON_LISTEN_443 };
    }
  }
  return null;
}

function secondServerRefusal(ref: DirectiveRef): Refusal | null {
  if (ref.scope.length === 0 && ref.name === "server") {
    return { line: ref.line, directive: "server", reason: REASON_SECOND_SERVER };
  }
  return null;
}

/**
 * A renamed upstream never arrives as `changed` — diffAst pairs block
 * directives by scopeKey, so `upstream stream_host_7_port_0` and
 * `upstream mine` have different identities and surface as one `removed`
 * plus one `added`. Detect that shape here.
 */
function upstreamRenameRefusal(delta: AstDelta): { refusal: Refusal; removed: DirectiveRef } | null {
  const hasAddedUpstream = delta.added.some((d) => d.name === "upstream");
  if (!hasAddedUpstream) return null;
  for (const d of delta.removed) {
    if (
      d.name === "upstream" &&
      (/^stream_host_\d+_port_\d+$/.test(d.args[0] ?? "") || /^host_\d+_loc_\d+$/.test(d.args[0] ?? ""))
    ) {
      return { refusal: { line: d.line, directive: "upstream", reason: REASON_UPSTREAM_RENAME }, removed: d };
    }
  }
  return null;
}

// ── Flag directives (removal ⇒ field goes false) ──

function flagRemovalEdit(ref: DirectiveRef): ClassifiedEdit | null {
  if (ref.name === "add_header" && ref.args[0] === "Strict-Transport-Security") {
    return { kind: "field", field: "hsts", from: true, to: false, label: "Strict-Transport-Security header removed → HSTS off" };
  }
  if (ref.name === "http2" && ref.args.includes("on")) {
    return { kind: "field", field: "http2", from: true, to: false, label: "http2 on removed → HTTP/2 off" };
  }
  if (ref.name === "gzip" && ref.args.includes("on")) {
    return { kind: "field", field: "compression", from: true, to: false, label: "gzip on removed → Compression off" };
  }
  if (ref.name === "if") {
    const argsStr = ref.args.join(" ");
    if (argsStr.includes("www")) {
      return { kind: "field", field: "redirectWww", from: true, to: false, label: "www redirect block removed → Redirect www off" };
    }
    if (argsStr.includes("scheme")) {
      return { kind: "field", field: "sslForceHttps", from: true, to: false, label: "force-https redirect block removed → Force HTTPS off" };
    }
  }
  return null;
}

// ── SERVER_FIELDS whitelist ──

type ServerFieldHandler = (ref: DirectiveRef, host: HostConfig) => ClassifiedEdit;

const SERVER_FIELDS: Record<string, ServerFieldHandler> = {
  client_max_body_size: (ref, host) => ({
    kind: "field",
    field: "clientMaxBodySize",
    from: host.clientMaxBodySize,
    to: ref.args[0],
    label: `client_max_body_size ${host.clientMaxBodySize} → ${ref.args[0]}`,
  }),
  server_name: (ref, host) => ({
    kind: "field",
    field: "domains",
    from: host.domains,
    to: [...ref.args],
    label: `server_name ${host.domains.join(" ")} → ${ref.args.join(" ")}`,
  }),
  ssl_certificate: (ref, host) => ({
    kind: "field",
    field: "sslCertPath",
    from: host.sslCertPath,
    to: ref.args[0],
    label: `ssl_certificate ${host.sslCertPath ?? "(none)"} → ${ref.args[0]}`,
  }),
  ssl_certificate_key: (ref, host) => ({
    kind: "field",
    field: "sslKeyPath",
    from: host.sslKeyPath,
    to: ref.args[0],
    label: `ssl_certificate_key ${host.sslKeyPath ?? "(none)"} → ${ref.args[0]}`,
  }),
};

// ── LOCATION_FIELDS whitelist ──

type LocationFieldHandler = (ref: DirectiveRef, loc: Location, index: number) => ClassifiedEdit[];

const LOCATION_FIELDS: Record<string, LocationFieldHandler> = {
  proxy_pass: (ref, loc, index) => {
    const target = ref.args[0] ?? "";
    const m = /^([a-z]+):\/\/([^:/]+)(?::(\d+))?/i.exec(target);
    const scheme = m?.[1] ?? "http";
    const server = m?.[2] ?? "";
    const port = m?.[3] ? Number(m[3]) : scheme === "https" ? 443 : 80;
    const prev = loc.upstreams[0];
    const newUpstreams = [{ server, port, weight: prev?.weight ?? 1, protocol: prev?.protocol }];
    const edits: ClassifiedEdit[] = [
      {
        kind: "location-field",
        index,
        field: "upstreams",
        from: loc.upstreams,
        to: newUpstreams,
        label: `proxy_pass → ${target}`,
      },
    ];
    if (scheme !== loc.forwardScheme) {
      edits.push({
        kind: "location-field",
        index,
        field: "forwardScheme",
        from: loc.forwardScheme,
        to: scheme,
        label: `forwardScheme ${loc.forwardScheme} → ${scheme}`,
      });
    }
    return edits;
  },
  alias: (ref, loc, index) => [
    {
      kind: "location-field",
      index,
      field: "staticDir",
      from: loc.staticDir,
      to: ref.args[0],
      label: `alias ${loc.staticDir} → ${ref.args[0]}`,
    },
  ],
  root: (ref, loc, index) => [
    {
      kind: "location-field",
      index,
      field: "staticDir",
      from: loc.staticDir,
      to: ref.args[0],
      label: `root ${loc.staticDir} → ${ref.args[0]}`,
    },
  ],
  expires: (ref, loc, index) => [
    {
      kind: "location-field",
      index,
      field: "cacheExpires",
      from: loc.cacheExpires,
      to: ref.args[0],
      label: `expires ${loc.cacheExpires} → ${ref.args[0]}`,
    },
  ],
  return: (ref, loc, index) => {
    const status = Number(ref.args[0]);
    const target = ref.args[1] ?? "";
    const m = /^([a-z]+):\/\/([^/]+)(\/.*)?$/i.exec(target);
    const domain = m?.[2] ?? loc.forwardDomain;
    const path = m?.[3] ?? loc.forwardPath ?? "/";
    return [
      {
        kind: "location-field",
        index,
        field: "statusCode",
        from: loc.statusCode,
        to: status,
        label: `return ${loc.statusCode} → ${status}`,
      },
      {
        kind: "location-field",
        index,
        field: "forwardDomain",
        from: loc.forwardDomain,
        to: domain,
        label: `forwardDomain ${loc.forwardDomain} → ${domain}`,
      },
      {
        kind: "location-field",
        index,
        field: "forwardPath",
        from: loc.forwardPath,
        to: path,
        label: `forwardPath ${loc.forwardPath} → ${path}`,
      },
    ];
  },
  proxy_set_header: (ref, loc, index) => {
    const [key, ...rest] = ref.args;
    const value = rest.join(" ");
    const newHeaders = { ...loc.headers, [key]: value };
    return [
      {
        kind: "location-field",
        index,
        field: "headers",
        from: loc.headers,
        to: newHeaders,
        label: `proxy_set_header ${key} → ${value}`,
      },
    ];
  },
};

// ── location-removed "losing" enumeration ──

function losingList(loc: Location | undefined): string[] {
  if (!loc) return [];
  const losing: string[] = [];
  if (loc.accessListId) losing.push(`access list #${loc.accessListId}`);
  const auth = loc.basicAuth;
  if (auth && "enabled" in auth && auth.enabled && (auth as { users: Array<unknown> }).users?.length > 0) {
    losing.push(`basic auth (${(auth as { users: Array<unknown> }).users.length} users)`);
  }
  for (const key of Object.keys(loc.headers ?? {})) {
    losing.push(`header ${key}`);
  }
  return losing;
}

function locationRemovedEdit(ref: DirectiveRef, host: HostConfig): ClassifiedEdit {
  const scope = refIdentityKey(ref);
  const { path } = parseLocationScope(scope);
  const index = findLocationIndex(host, scope);
  const loc = index >= 0 ? host.locations[index] : undefined;
  return {
    kind: "location-removed",
    index,
    label: `location ${path} removed`,
    losing: losingList(loc),
  };
}

function locationAddedEdit(ref: DirectiveRef): ClassifiedEdit {
  const scope = refIdentityKey(ref);
  const { path, matchType } = parseLocationScope(scope);
  const { type, body } = detectLocationCore(ref.text);
  return {
    kind: "location-added",
    path,
    matchType,
    type,
    body,
    label: `location ${path} → new ${type} location`,
  };
}

// ── Main classifier ──

export function classifyDelta(delta: AstDelta, host: HostConfig): Classification {
  const edits: ClassifiedEdit[] = [];
  const refusals: Refusal[] = [];

  const consumedAdded = new Set<DirectiveRef>();
  const consumedRemoved = new Set<DirectiveRef>();
  const consumedChangedAfter = new Set<DirectiveRef>();

  // 1. Refusal checks first — a refusal beats any mapping.
  for (const c of delta.changed) {
    const r = certRefusal(c.after, host) ?? globalSettingsRefusal(c.after);
    if (r) {
      refusals.push(r);
      consumedChangedAfter.add(c.after);
    }
  }
  for (const d of delta.added) {
    const r = certRefusal(d, host) ?? globalSettingsRefusal(d) ?? secondServerRefusal(d);
    if (r) {
      refusals.push(r);
      consumedAdded.add(d);
    }
  }
  const rename = upstreamRenameRefusal(delta);
  if (rename) {
    refusals.push(rename.refusal);
    consumedRemoved.add(rename.removed);
    // The paired "added" upstream is half of the same refused rename —
    // don't also surface it as a prelude edit.
    for (const d of delta.added) {
      if (d.name === "upstream") consumedAdded.add(d);
    }
  }
  for (const d of delta.removed) {
    if (consumedRemoved.has(d)) continue;
    const r = globalSettingsRefusal(d) ?? listen443Refusal(d);
    if (r) {
      refusals.push(r);
      consumedRemoved.add(d);
    }
  }

  // 5. Added/removed `location` blocks — count-based, design record §refusal 5.
  const addedLocations = delta.added.filter(
    (d) => !consumedAdded.has(d) && d.name === "location" && d.scope.length === 1 && d.scope[0] === "server"
  );
  const removedLocations = delta.removed.filter(
    (d) => !consumedRemoved.has(d) && d.name === "location" && d.scope.length === 1 && d.scope[0] === "server"
  );
  for (const l of addedLocations) consumedAdded.add(l);
  for (const l of removedLocations) consumedRemoved.add(l);

  const locTotal = addedLocations.length + removedLocations.length;
  if (locTotal >= 2 && !(addedLocations.length === 1 && removedLocations.length === 1)) {
    const line = Math.min(...removedLocations.map((l) => l.line), ...addedLocations.map((l) => l.line));
    refusals.push({ line, directive: "location", reason: REASON_AMBIGUOUS_LOCATIONS });
  } else {
    for (const l of removedLocations) edits.push(locationRemovedEdit(l, host));
    for (const l of addedLocations) edits.push(locationAddedEdit(l));
  }

  // 2. Scope [] (outside server {}) → prelude.
  for (const d of delta.added) {
    if (consumedAdded.has(d)) continue;
    if (d.scope.length === 0) {
      edits.push({ kind: "prelude", text: d.text, label: `${refIdentityKey(d)} → prelude` });
      consumedAdded.add(d);
    }
  }
  for (const c of delta.changed) {
    if (consumedChangedAfter.has(c.after)) continue;
    if (c.after.scope.length === 0) {
      edits.push({ kind: "prelude", text: c.after.text, label: `${refIdentityKey(c.after)} → prelude` });
      consumedChangedAfter.add(c.after);
    }
  }
  // Removed prelude content (e.g. a `map`/`upstream` block that isn't part
  // of an upstream rename) has no representation in the ClassifiedEdit union
  // — refuse instead of silently dropping the line. See NUANCES.md #16.
  for (const d of delta.removed) {
    if (consumedRemoved.has(d)) continue;
    if (d.scope.length === 0) {
      refusals.push({ line: d.line, directive: d.name, reason: REASON_UNMAPPABLE_REMOVAL });
      consumedRemoved.add(d);
    }
  }

  // 3 & 4. Scope ["server"] → whitelist / server-advanced.
  //        Scope ["server", "location …"] → whitelist / location-advanced.
  for (const c of delta.changed) {
    if (consumedChangedAfter.has(c.after)) continue;
    classifyServerOrLocationEntry(c.after, host, edits);
  }
  for (const d of delta.added) {
    if (consumedAdded.has(d)) continue;
    classifyServerOrLocationEntry(d, host, edits);
  }
  for (const d of delta.removed) {
    if (consumedRemoved.has(d)) continue;
    if (d.scope.length === 1 && d.scope[0] === "server") {
      // 6. Flag removals.
      const flagEdit = flagRemovalEdit(d);
      if (flagEdit) {
        edits.push(flagEdit);
      } else {
        // Any other unmatched removal at server scope has no raw-text
        // representation to remove from (advancedNginx is additive text) —
        // refuse rather than silently drop the line. See NUANCES.md #16.
        refusals.push({ line: d.line, directive: d.name, reason: REASON_UNMAPPABLE_REMOVAL });
      }
      consumedRemoved.add(d);
      continue;
    }
    if (d.scope.length === 2 && d.scope[0] === "server") {
      // Removed directive inside a matched location that isn't the removal
      // of the whole location block itself (that's handled above, §5) —
      // no field-level "unset" representation exists yet. Refuse rather
      // than silently drop the line. See NUANCES.md #16.
      refusals.push({ line: d.line, directive: d.name, reason: REASON_UNMAPPABLE_REMOVAL });
      consumedRemoved.add(d);
    }
  }

  return { edits, refusals };
}

function classifyServerOrLocationEntry(ref: DirectiveRef, host: HostConfig, edits: ClassifiedEdit[]): void {
  if (ref.scope.length === 1 && ref.scope[0] === "server" && ref.name !== "location") {
    const handler = SERVER_FIELDS[ref.name];
    if (handler) {
      edits.push(handler(ref, host));
    } else {
      edits.push({ kind: "server-advanced", text: ref.text, label: `${ref.name} → Advanced` });
    }
    return;
  }

  if (ref.scope.length === 2 && ref.scope[0] === "server") {
    const scope = ref.scope[1];
    const index = findLocationIndex(host, scope);
    if (index < 0) return; // matched-location children should always resolve; guard defensively
    const loc = host.locations[index];
    const handler = LOCATION_FIELDS[ref.name];
    if (handler) {
      edits.push(...handler(ref, loc, index));
    } else {
      edits.push({
        kind: "location-advanced",
        index,
        text: ref.text,
        label: `${ref.name} → Advanced (location ${loc.path})`,
      });
    }
  }
}
