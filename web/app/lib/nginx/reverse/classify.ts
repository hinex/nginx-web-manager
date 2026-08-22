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
  | { kind: "prelude"; text: string; label: string }
  // Task 8 (stream): streamPorts[] has no advanced/raw escape hatch in the
  // schema (unlike locations[].advanced / advancedNginx), so the stream
  // branch only ever produces this one field-shaped edit kind, or a refusal
  // — see classifyStreamDelta below.
  | { kind: "stream-field"; index: number; field: string; from: unknown; to: unknown; label: string };

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
const REASON_UNMAPPABLE_EDIT =
  "This change could not be mapped back to any host field — revert the line, or make the change in the host form";
const REASON_PROXY_BOILERPLATE =
  "proxy_set_header lines are generated from the location's type and cannot be edited here — put custom request headers in Advanced Nginx Directives";
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

/**
 * Directives buildServerBlock emits alongside `gzip on;` whenever
 * host.compression is true (server-block.ts, "// Compression").
 *
 * Turning the flag off in the UI deletes all five lines at once, so a user
 * deleting the same fragment by hand must be read as one flag change. Before
 * this set existed, `gzip on` mapped to the flag but its four companions each
 * hit REASON_UNMAPPABLE_REMOVAL — and a single refusal rejects the whole
 * edit, so removing the compression block by hand was impossible.
 */
const GZIP_COMPANIONS = new Set(["gzip_vary", "gzip_proxied", "gzip_comp_level", "gzip_types"]);

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

/**
 * A whitelisted server-scope directive: `field` is the host field it maps to
 * (the single source of truth reused as-is by Task 6's model-line
 * highlighting — do not restate this table anywhere else), `build` produces
 * the actual ClassifiedEdit for a real delta entry.
 */
export interface ServerFieldEntry {
  field: string;
  build: ServerFieldHandler;
}

export const SERVER_FIELDS: Record<string, ServerFieldEntry> = {
  client_max_body_size: {
    field: "clientMaxBodySize",
    build: (ref, host) => ({
      kind: "field",
      field: "clientMaxBodySize",
      from: host.clientMaxBodySize,
      to: ref.args[0],
      label: `client_max_body_size ${host.clientMaxBodySize} → ${ref.args[0]}`,
    }),
  },
  server_name: {
    field: "domains",
    build: (ref, host) => ({
      kind: "field",
      field: "domains",
      from: host.domains,
      to: [...ref.args],
      label: `server_name ${host.domains.join(" ")} → ${ref.args.join(" ")}`,
    }),
  },
  ssl_certificate: {
    field: "sslCertPath",
    build: (ref, host) => ({
      kind: "field",
      field: "sslCertPath",
      from: host.sslCertPath,
      to: ref.args[0],
      label: `ssl_certificate ${host.sslCertPath ?? "(none)"} → ${ref.args[0]}`,
    }),
  },
  ssl_certificate_key: {
    field: "sslKeyPath",
    build: (ref, host) => ({
      kind: "field",
      field: "sslKeyPath",
      from: host.sslKeyPath,
      to: ref.args[0],
      label: `ssl_certificate_key ${host.sslKeyPath ?? "(none)"} → ${ref.args[0]}`,
    }),
  },
};

// ── LOCATION_FIELDS whitelist ──

type LocationFieldHandler = (ref: DirectiveRef, loc: Location, index: number) => ClassifiedEdit[];

/**
 * A whitelisted location-scope directive: `field` is the primary location
 * field it maps to (the same table Task 6's model-line highlighting reuses
 * verbatim — do not restate it), `build` produces the actual edit(s).
 */
export interface LocationFieldEntry {
  field: string;
  build: LocationFieldHandler;
}

export const LOCATION_FIELDS: Record<string, LocationFieldEntry> = {
  proxy_pass: {
    field: "upstreams",
    build: (ref, loc, index) => {
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
  },
  alias: {
    field: "staticDir",
    build: (ref, loc, index) => [
      {
        kind: "location-field",
        index,
        field: "staticDir",
        from: loc.staticDir,
        to: ref.args[0],
        label: `alias ${loc.staticDir} → ${ref.args[0]}`,
      },
    ],
  },
  root: {
    field: "staticDir",
    build: (ref, loc, index) => [
      {
        kind: "location-field",
        index,
        field: "staticDir",
        from: loc.staticDir,
        to: ref.args[0],
        label: `root ${loc.staticDir} → ${ref.args[0]}`,
      },
    ],
  },
  expires: {
    field: "cacheExpires",
    build: (ref, loc, index) => [
      {
        kind: "location-field",
        index,
        field: "cacheExpires",
        from: loc.cacheExpires,
        to: ref.args[0],
        label: `expires ${loc.cacheExpires} → ${ref.args[0]}`,
      },
    ],
  },
  return: {
    field: "statusCode",
    build: (ref, loc, index) => {
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
  },
  // The generator renders `loc.headers` as `add_header K "V";`
  // (server-block.ts:346), so `add_header` — not `proxy_set_header` — is the
  // directive that represents this field. Reading the other one wrote request
  // headers into a response-header field and reverted the user's actual edit
  // on the next regeneration (NUANCES §49).
  add_header: {
    field: "headers",
    build: (ref, loc, index) => {
      const [key, ...rest] = ref.args;
      // HSTS is owned by the `hsts` flag (see flagRemovalEdit above). Letting it
      // also reach `headers` would give one rendered line two sources of truth.
      if (key === "Strict-Transport-Security") return [];
      // The template writes the value quoted and stores it bare, so a round-trip
      // that skipped this would grow a pair of quotes on every save.
      const value = rest.join(" ").replace(/^"(.*)"$/s, "$1");
      const newHeaders = { ...loc.headers, [key]: value };
      return [
        {
          kind: "location-field",
          index,
          field: "headers",
          from: loc.headers,
          to: newHeaders,
          label: `add_header ${key} → ${value}`,
        },
      ];
    },
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

  // A pure addition needs no pairing at all: locationAddedEdit reads only the
  // added block and applyEdits appends, so N additions are N independent edits.
  // The original count guard (design record §refusal 5) refused them anyway,
  // which rejected an ordinary paste of several static locations (§60).
  //
  // Removals stay under the guard. findLocationIndex resolves with findIndex,
  // so two removed locations sharing path+matchType both answer with the first
  // index — the §44 collapse shape, applied to deletion. Widening that needs
  // occurrence-aware index resolution first; until then refusing is honest.
  const locTotal = addedLocations.length + removedLocations.length;
  const pureAddition = removedLocations.length === 0;
  if (!pureAddition && locTotal >= 2 && !(addedLocations.length === 1 && removedLocations.length === 1)) {
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
    if (classifyServerOrLocationEntry(c.after, host, edits, refusals)) consumedChangedAfter.add(c.after);
  }
  for (const d of delta.added) {
    if (consumedAdded.has(d)) continue;
    if (classifyServerOrLocationEntry(d, host, edits, refusals)) consumedAdded.add(d);
  }
  // Only absorb the gzip companions when `gzip on` itself is going away in the
  // same delta; deleting a companion on its own stays a refusal, otherwise the
  // user's intent to drop that one line would vanish without a trace.
  const compressionRemoved = delta.removed.some(
    (d) => d.name === "gzip" && d.args.includes("on") && d.scope.length === 1 && d.scope[0] === "server"
  );
  for (const d of delta.removed) {
    if (consumedRemoved.has(d)) continue;
    if (d.scope.length === 1 && d.scope[0] === "server") {
      // 6. Flag removals.
      const flagEdit = flagRemovalEdit(d);
      if (flagEdit) {
        edits.push(flagEdit);
      } else if (compressionRemoved && GZIP_COMPANIONS.has(d.name)) {
        // Same fragment as the `gzip on` removal above — already represented
        // by that single compression edit.
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

  // ── Upstream bodies → loc.upstreams / loc.balanceMethod ─────────────────
  //
  // `upstream host_<id>_loc_<i> {}` is generated from `loc.upstreams[]` and its
  // name encodes the location index, so a hand edit here IS representable. It
  // used to fall past every scope gate; §51's sweep made that a refusal rather
  // than a silent loss, and this makes it actually work.
  //
  // Two rules keep this from becoming another §49 (a mapping that looks right
  // and quietly corrupts):
  //  1. `protocol` lives on the model but is NEVER rendered in the upstream
  //     block (it feeds `proxy_pass <protocol>://…`). Reconstructing from text
  //     alone would erase it, so it is carried across by value-matching the
  //     pre-edit entry, and inherited from the first upstream for added lines
  //     — the same rule the form uses when you click "Add Upstream".
  //  2. Anything in a `server` line beyond `host:port` and `weight=N` has no
  //     field to land in (`max_fails`, `backup`, …). Rather than parsing what
  //     we understand and dropping the rest, the whole bucket is left for the
  //     final sweep to refuse.
  const upstreamScope = new RegExp(`^upstream host_${host.id}_loc_(\\d+)$`);
  type UpEntry = { ref: DirectiveRef; kind: "added" | "removed" | "changed"; beforeArgs?: string[] };
  const byLocation = new Map<number, UpEntry[]>();

  const collectUpstream = (ref: DirectiveRef, kind: UpEntry["kind"], beforeArgs?: string[]) => {
    if (ref.scope.length !== 1) return;
    const m = upstreamScope.exec(ref.scope[0]);
    if (!m) return;
    const idx = Number(m[1]);
    if (!byLocation.has(idx)) byLocation.set(idx, []);
    byLocation.get(idx)!.push({ ref, kind, beforeArgs });
  };
  for (const d of delta.added) if (!consumedAdded.has(d)) collectUpstream(d, "added");
  for (const d of delta.removed) if (!consumedRemoved.has(d)) collectUpstream(d, "removed");
  for (const c of delta.changed) {
    if (!consumedChangedAfter.has(c.after)) collectUpstream(c.after, "changed", c.before.args);
  }

  for (const [idx, entries] of byLocation) {
    const loc = host.locations[idx];
    if (!loc) continue; // names a location this host does not have — swept below

    const unknown = entries.some(
      (e) => e.ref.name !== "server" && !BALANCE_DIRECTIVE_NAMES.has(e.ref.name)
    );
    const unrepresentable = entries.some(
      (e) => e.ref.name === "server" && !isPlainUpstreamServer(e.ref.args)
    );
    if (unknown || unrepresentable) continue; // swept below as refusals

    const existing = loc.upstreams ?? [];
    const fallbackProtocol = existing[0]?.protocol;
    const upstreams = existing.map((u) => ({ ...u }));
    const consumedIdx = new Set<number>();
    const findByValue = (v: StreamUpstream) =>
      upstreams.findIndex(
        (u, i) =>
          !consumedIdx.has(i) && u.server === v.server && u.port === v.port && u.weight === v.weight
      );
    const withProtocol = (v: StreamUpstream, protocol: string | undefined) =>
      protocol === undefined ? { ...v } : { ...v, protocol };

    const serverEntries = entries.filter((e) => e.ref.name === "server");
    for (const e of serverEntries) {
      if (e.kind !== "changed" || !e.beforeArgs) continue;
      const at = findByValue(parseServerLine(e.beforeArgs.join(" ")));
      const next = parseServerLine(e.ref.args.join(" "));
      if (at >= 0) {
        upstreams[at] = withProtocol(next, upstreams[at].protocol);
        consumedIdx.add(at);
      } else {
        upstreams.push(withProtocol(next, fallbackProtocol));
      }
    }
    for (const e of serverEntries) {
      if (e.kind !== "removed") continue;
      const at = findByValue(parseServerLine(e.ref.args.join(" ")));
      if (at >= 0) {
        upstreams.splice(at, 1);
        consumedIdx.add(at);
      }
    }
    for (const e of serverEntries) {
      if (e.kind !== "added") continue;
      upstreams.push(withProtocol(parseServerLine(e.ref.args.join(" ")), fallbackProtocol));
    }

    // Same round-trip trap as the stream branch: buildUpstreamBlock emits no
    // directive for "round_robin" and none for "weighted" either (weight rides
    // on the server lines), so only explicit evidence may move this field.
    const balanceAdded = entries.find(
      (e) => e.kind === "added" && BALANCE_DIRECTIVE_NAMES.has(e.ref.name)
    );
    const balanceRemoved = entries.find(
      (e) => e.kind === "removed" && BALANCE_DIRECTIVE_NAMES.has(e.ref.name)
    );
    let balanceMethod = loc.balanceMethod;
    if (balanceAdded) {
      balanceMethod = balanceAdded.ref.name;
    } else if (
      balanceRemoved ||
      (serverEntries.length > 0 && !BALANCE_DIRECTIVE_NAMES.has(loc.balanceMethod))
    ) {
      balanceMethod = upstreams.some((u) => u.weight > 1) ? "weighted" : "round_robin";
    }

    // A proxy location with no upstreams is a state `validate.ts:56` refuses to
    // publish. Writing it here would poison the row: the file edit would appear
    // to succeed and the host form would then refuse to publish the host, with
    // nothing pointing back at the deleted line. Refuse at the source instead.
    if (loc.type === "proxy" && upstreams.length === 0) continue; // swept below

    let produced = false;
    if (JSON.stringify(upstreams) !== JSON.stringify(existing)) {
      edits.push({
        kind: "location-field",
        index: idx,
        field: "upstreams",
        from: existing,
        to: upstreams,
        label: `location ${loc.path} upstreams updated`,
      });
      produced = true;
    }
    if (balanceMethod !== loc.balanceMethod) {
      edits.push({
        kind: "location-field",
        index: idx,
        field: "balanceMethod",
        from: loc.balanceMethod,
        to: balanceMethod,
        label: `balanceMethod ${loc.balanceMethod} → ${balanceMethod}`,
      });
      produced = true;
    }
    // Producing nothing means the text changed in a way this reconstruction
    // cannot see — leave the entries unconsumed so the sweep refuses them.
    if (!produced) continue;
    for (const e of entries) {
      if (e.kind === "added") consumedAdded.add(e.ref);
      else if (e.kind === "removed") consumedRemoved.add(e.ref);
      else consumedChangedAfter.add(e.ref);
    }
  }

  // ── Final sweep: nothing may leave this function unexplained ─────────────
  //
  // Every branch above is gated on a scope shape it recognises (`[]`,
  // `["server"]`, `["server", "location …"]`). A ref in any other scope — a
  // second `server#1` block, the body of an `upstream`, a location that no
  // longer resolves — used to fall past all of them and vanish: the file
  // changed, the delta was non-empty, and the save reported success having
  // written nothing. That is the exact signature of §42/§44/§45/§49.
  //
  // Rather than adding a fourth scope-specific branch (and leaving a fifth
  // shape to be discovered later), anything still unconsumed is refused by
  // construction. A refusal is always a truthful answer here: it says the
  // line could not be mapped and points the user at the form. Silence is the
  // only answer that is never truthful. Guarded by invariant.test.ts.
  for (const d of delta.added) {
    if (!consumedAdded.has(d)) {
      refusals.push({ line: d.line, directive: d.name, reason: REASON_UNMAPPABLE_EDIT });
    }
  }
  for (const c of delta.changed) {
    if (!consumedChangedAfter.has(c.after)) {
      refusals.push({ line: c.after.line, directive: c.after.name, reason: REASON_UNMAPPABLE_EDIT });
    }
  }
  for (const d of delta.removed) {
    if (!consumedRemoved.has(d)) {
      refusals.push({ line: d.line, directive: d.name, reason: REASON_UNMAPPABLE_REMOVAL });
    }
  }

  return { edits, refusals };
}

/**
 * True when an edit changes nothing. A delta entry only reaches the whitelist
 * because the *text* moved, so a no-op edit is not an edit — it is proof the
 * handler read the part of the line it understood and dropped the rest. Every
 * single-argument handler has this shape: `ssl_certificate /c.pem backup.pem;`
 * reads `args[0]`, produces `/c.pem → /c.pem`, and the extra token vanishes.
 *
 * Accepting it reported a successful save, wrote a row identical to the old
 * one, and let the `generateAllConfigs()` on that same save restore the
 * original line — the user reloaded and found their edit gone, with no refusal
 * and no error anywhere. That is the §49 signature, and it survives any
 * per-directive arity rule that a future table entry forgets to add.
 *
 * Dropping the edit leaves the ref unconsumed so the final sweep refuses it,
 * which is the honest answer: this line says something the model cannot hold.
 */
function isNoOpEdit(edit: ClassifiedEdit): boolean {
  if (!("from" in edit) || !("to" in edit)) return false;
  const { from, to } = edit as { from: unknown; to: unknown };
  return JSON.stringify(from ?? null) === JSON.stringify(to ?? null);
}

function classifyServerOrLocationEntry(
  ref: DirectiveRef,
  host: HostConfig,
  edits: ClassifiedEdit[],
  refusals: Refusal[]
): boolean {
  // proxy_set_header is emitted from the location's type/forwardScheme/
  // preservePath, never from an editable field, so a hand edit here has no
  // model representation. Refuse loudly with a named remedy instead of
  // absorbing it into raw text where the next regeneration would drop it.
  if (ref.name === "proxy_set_header") {
    refusals.push({ line: ref.line, directive: ref.name, reason: REASON_PROXY_BOILERPLATE });
    return true;
  }
  if (ref.scope.length === 1 && ref.scope[0] === "server" && ref.name !== "location") {
    const entry = SERVER_FIELDS[ref.name];
    if (entry) {
      const built = [entry.build(ref, host)].filter((e) => !isNoOpEdit(e));
      if (built.length === 0) return false; // read part of the line — sweep refuses it
      edits.push(...built);
    } else {
      edits.push({ kind: "server-advanced", text: ref.text, label: `${ref.name} → Advanced` });
    }
    return true;
  }

  if (ref.scope.length === 2 && ref.scope[0] === "server") {
    const scope = ref.scope[1];
    const index = findLocationIndex(host, scope);
    if (index < 0) return false; // unresolvable location — let the final sweep refuse it
    const loc = host.locations[index];
    const entry = LOCATION_FIELDS[ref.name];
    if (entry) {
      const built = entry.build(ref, loc, index).filter((e) => !isNoOpEdit(e));
      if (built.length === 0) return false; // read part of the line — sweep refuses it
      edits.push(...built);
    } else {
      edits.push({
        kind: "location-advanced",
        index,
        text: ref.text,
        label: `${ref.name} → Advanced (location ${loc.path})`,
      });
    }
    return true;
  }

  // Scopes this function does not recognise (a second `server#1` block, an
  // `upstream` body, anything nested deeper) reach here unhandled.
  return false;
}

// ── Stream branch (Task 8) ──────────────────────────────────────────────
//
// A stream host file (`stream.d/host-<id>-stream.conf`) has a completely
// different shape from an HTTP host file: there is no wrapping `server {}`
// for the whole file — each stream port emits its own anonymous
// `server { listen ...; proxy_pass ...; }` alongside a named
// `upstream stream_host_<id>_port_<i> {}` block, both directly at AST
// depth 0. Reusing classifyDelta/SERVER_FIELDS/LOCATION_FIELDS against it
// would silently mismap `listen`/`proxy_pass` onto the HTTP whitelist (whose
// scope strings happen to collide textually, e.g. both use `["server"]`),
// so this is a deliberately separate function/type family. See
// NUANCES.md #39+ for the reasoning and limitations below.

export interface StreamHostConfig {
  id: number;
  streamPorts: Array<{
    port: number;
    protocol: "tcp" | "udp";
    upstreams: Array<{ server: string; port: number; weight: number }>;
    balanceMethod: string;
    /** Raw directives for this port's `server {}` block — see templates/stream.ts. */
    advanced?: string | null;
  }>;
}

type StreamUpstream = StreamHostConfig["streamPorts"][number]["upstreams"][number];

const REASON_STREAM_UNMAPPABLE =
  "This directive has no equivalent stream host field — edit it in the host form, or revert the change";
const REASON_STREAM_STRUCTURE =
  "Adding or removing a stream port from the file isn't supported — use the host form instead";

const BALANCE_DIRECTIVE_NAMES = new Set(["least_conn", "ip_hash", "random"]);

function upstreamIndexFromScopeKey(hostId: number, key: string): number | null {
  const m = new RegExp(`^upstream stream_host_${hostId}_port_(\\d+)$`).exec(key);
  return m ? Number(m[1]) : null;
}

/**
 * True when a `server` line inside an upstream block says nothing the model
 * cannot hold: an `address:port`, optionally `weight=N`. Anything else
 * (`max_fails=`, `fail_timeout=`, `backup`, `down`, a stray token) would be
 * dropped by the reconstruction, so the caller refuses instead of half-reading.
 */
function isPlainUpstreamServer(args: string[]): boolean {
  if (args.length === 0) return false;
  const [addr, ...rest] = args;
  const colonIdx = addr.lastIndexOf(":");
  if (colonIdx <= 0) return false;
  if (!/^\d+$/.test(addr.slice(colonIdx + 1))) return false;
  return rest.every((p) => /^weight=\d+$/.test(p));
}

function parseServerLine(argsStr: string): StreamUpstream {
  const parts = argsStr.trim().split(/\s+/).filter(Boolean);
  const addr = parts[0] ?? "";
  const colonIdx = addr.lastIndexOf(":");
  const server = colonIdx >= 0 ? addr.slice(0, colonIdx) : addr;
  const port = colonIdx >= 0 ? Number(addr.slice(colonIdx + 1)) : NaN;
  const weightArg = parts.find((p) => p.startsWith("weight="));
  const weight = weightArg ? Number(weightArg.slice("weight=".length)) : 1;
  return { server, port, weight };
}

function parseListenLine(argsStr: string): { port: number; protocol: "tcp" | "udp" } {
  const parts = argsStr.trim().split(/\s+/).filter(Boolean);
  const protocol: "tcp" | "udp" = parts.includes("udp") ? "udp" : "tcp";
  const m = /(\d+)$/.exec(parts[0] ?? "");
  return { port: m ? Number(m[1]) : NaN, protocol };
}

function findStreamPortIndex(host: StreamHostConfig, port: number, protocol: "tcp" | "udp"): number {
  return host.streamPorts.findIndex((sp) => sp.port === port && sp.protocol === protocol);
}

type StreamEntry = {
  /** Set once this entry has produced an edit or a refusal; see the final sweep. */
  explained?: boolean;
  /** The single scope segment this ref sat in, e.g. "server" or "server#1". */
  scopeKey?: string;
  /** Rendered source text, used verbatim when the line lands in the advanced bucket. */
  text?: string;
  kind: "added" | "removed" | "changed";
  name: string;
  line: number;
  args: string[];
  beforeArgs?: string[];
};

/**
 * Classifies a delta produced against a stream host file. Kept entirely
 * separate from `classifyDelta` — see the block comment above.
 */
export function classifyStreamDelta(delta: AstDelta, host: StreamHostConfig): Classification {
  const edits: ClassifiedEdit[] = [];
  const refusals: Refusal[] = [];

  const consumedAdded = new Set<DirectiveRef>();
  const consumedRemoved = new Set<DirectiveRef>();
  const consumedChangedAfter = new Set<DirectiveRef>();

  // 1. resolver / set $backend_* — same global-settings refusal as HTTP.
  for (const c of delta.changed) {
    const r = globalSettingsRefusal(c.after);
    if (r) {
      refusals.push(r);
      consumedChangedAfter.add(c.after);
    }
  }
  for (const d of delta.added) {
    const r = globalSettingsRefusal(d);
    if (r) {
      refusals.push(r);
      consumedAdded.add(d);
    }
  }
  for (const d of delta.removed) {
    const r = globalSettingsRefusal(d);
    if (r) {
      refusals.push(r);
      consumedRemoved.add(d);
    }
  }

  // 2. Upstream rename — identical shape to the HTTP case: diffAst pairs
  // `upstream` blocks by scopeKey, so a rename never arrives as `changed`,
  // only as a removed+added pair. `upstreamRenameRefusal` already matches
  // both the HTTP (`host_<id>_loc_<i>`) and stream (`stream_host_<id>_port_<i>`)
  // naming patterns.
  const rename = upstreamRenameRefusal(delta);
  if (rename) {
    refusals.push(rename.refusal);
    consumedRemoved.add(rename.removed);
    for (const d of delta.added) {
      if (d.name === "upstream") consumedAdded.add(d);
    }
  }

  // 3. Any other whole `upstream`/`server` block added or removed at the top
  // level would add or remove an entire stream port. There is no
  // ClassifiedEdit shape for that (the plan's whitelist only covers
  // directive-level edits within an existing port) and no raw escape hatch
  // to stash it in — refuse rather than guess.
  for (const d of delta.added) {
    if (consumedAdded.has(d)) continue;
    if (d.scope.length === 0 && (d.name === "upstream" || d.name === "server")) {
      refusals.push({ line: d.line, directive: d.name, reason: REASON_STREAM_STRUCTURE });
      consumedAdded.add(d);
    }
  }
  for (const d of delta.removed) {
    if (consumedRemoved.has(d)) continue;
    if (d.scope.length === 0 && (d.name === "upstream" || d.name === "server")) {
      refusals.push({ line: d.line, directive: d.name, reason: REASON_STREAM_STRUCTURE });
      consumedRemoved.add(d);
    }
  }

  // 4. Bucket everything else by the upstream index it belongs to (decoded
  // from the `upstream stream_host_<id>_port_<i>` scope name) or by the
  // top-level anonymous `server` scope (listen/proxy_pass/unknown).
  //
  // Anonymous `server {}` blocks all render with the same scopeKey, so
  // match.ts indexBlocks() disambiguates siblings by occurrence: the first
  // keeps the bare "server", later ones become "server#1", "server#2", …
  // The suffix is accepted here but not used to pick the port — a `listen`
  // edit is attributed by its *value* via findStreamPortIndex() below,
  // which stays correct even if the blocks are reordered in the file.
  /** The bare "server" plus the "#N" occurrence suffixes from match.ts indexBlocks(). */
  const ANON_SERVER_SCOPE = /^server(#\d+)?$/;

  /**
   * Recover the port index from the anonymous-server occurrence suffix.
   *
   * `listen` edits above are attributed by *value* precisely because that
   * survives reordering. A raw directive has no value to match on, so this
   * falls back to position: buildStreamBlock emits exactly one `server {}` per
   * port, in order, and match.ts numbers siblings in the same order — so
   * occurrence N is streamPorts[N]. If a user reorders the blocks by hand the
   * text lands on the wrong port, which is why the caller also bounds-checks
   * against the model and refuses anything it cannot place.
   */
  function portIndexFromServerScope(key: string | undefined): number | null {
    if (!key) return null;
    const m = /^server(?:#(\d+))?$/.exec(key);
    if (!m) return null;
    return m[1] ? Number(m[1]) : 0;
  }

  const byUpstreamIndex = new Map<number, StreamEntry[]>();
  const serverScopeEntries: StreamEntry[] = [];

  /** Every entry ever bucketed, so the final sweep can find the ones nothing spoke for. */
  const allEntries: StreamEntry[] = [];

  function bucket(ref: DirectiveRef, kind: StreamEntry["kind"], beforeArgs?: string[]) {
    const entry: StreamEntry = {
      kind,
      name: ref.name,
      line: ref.line,
      args: ref.args,
      beforeArgs,
      scopeKey: ref.scope.length === 1 ? ref.scope[0] : undefined,
      text: ref.text,
    };
    allEntries.push(entry);
    if (ref.scope.length !== 1) return; // nested deeper than a top-level block — swept below
    const idx = upstreamIndexFromScopeKey(host.id, ref.scope[0]);
    if (idx !== null) {
      if (!byUpstreamIndex.has(idx)) byUpstreamIndex.set(idx, []);
      byUpstreamIndex.get(idx)!.push(entry);
    } else if (ANON_SERVER_SCOPE.test(ref.scope[0])) {
      serverScopeEntries.push(entry);
    }
  }

  for (const d of delta.added) {
    if (!consumedAdded.has(d)) bucket(d, "added");
  }
  for (const d of delta.removed) {
    if (!consumedRemoved.has(d)) bucket(d, "removed");
  }
  for (const c of delta.changed) {
    if (!consumedChangedAfter.has(c.after)) bucket(c.after, "changed", c.before.args);
  }

  // 5. Per-upstream reconstruction: `upstreams[]` (by value-matching, since
  // DirectiveRef carries no positional index) and `balanceMethod` (see the
  // round-trip note on buildUpstreamBlock below).
  for (const [idx, entries] of byUpstreamIndex) {
    const port = host.streamPorts[idx];
    if (!port) continue; // index decoded from the name but no matching model entry — swept below

    const unknown = entries.find((e) => e.name !== "server" && !BALANCE_DIRECTIVE_NAMES.has(e.name));
    if (unknown) {
      refusals.push({ line: unknown.line, directive: unknown.name, reason: REASON_STREAM_UNMAPPABLE });
      for (const e of entries) e.explained = true;
      continue;
    }

    const serverEntries = entries.filter((e) => e.name === "server");
    const balanceAdded = entries.find((e) => e.kind === "added" && BALANCE_DIRECTIVE_NAMES.has(e.name));
    const balanceRemoved = entries.find((e) => e.kind === "removed" && BALANCE_DIRECTIVE_NAMES.has(e.name));

    // Value-match `changed`/`removed` server lines against the current model
    // array (rather than trusting sequential position — see match.ts's
    // grouping, which preserves relative order per name but nothing tells us
    // which original index a bare `changed`/`removed` entry came from when
    // more than one server line exists).
    const upstreams: StreamUpstream[] = port.upstreams.map((u) => ({ ...u }));
    const consumedIdx = new Set<number>();
    const findByValue = (v: StreamUpstream) =>
      upstreams.findIndex(
        (u, i) => !consumedIdx.has(i) && u.server === v.server && u.port === v.port && u.weight === v.weight
      );

    for (const e of serverEntries) {
      if (e.kind === "changed" && e.beforeArgs) {
        const before = parseServerLine(e.beforeArgs.join(" "));
        const at = findByValue(before);
        const next = parseServerLine(e.args.join(" "));
        if (at >= 0) {
          upstreams[at] = next;
          consumedIdx.add(at);
        } else {
          upstreams.push(next);
        }
      }
    }
    for (const e of serverEntries) {
      if (e.kind === "removed") {
        const val = parseServerLine(e.args.join(" "));
        const at = findByValue(val);
        if (at >= 0) {
          upstreams.splice(at, 1);
          consumedIdx.add(at);
        }
      }
    }
    for (const e of serverEntries) {
      if (e.kind === "added") {
        upstreams.push(parseServerLine(e.args.join(" ")));
      }
    }

    // balanceMethod round-trip: buildUpstreamBlock (templates/upstream.ts)
    // emits NO directive at all for "round_robin", and ALSO no directive for
    // "weighted" (weight is carried on the `server` lines instead, only
    // appended when weight > 1). So:
    //  - an explicit directive appearing/disappearing always wins;
    //  - otherwise, only actual weight>1 evidence in the reconstructed
    //    upstreams[] can move the model between "round_robin" and "weighted"
    //    — if nothing weight-related changed, balanceMethod must not be
    //    touched at all (the trap this task calls out explicitly: never
    //    silently flip weighted<->round_robin on an unrelated edit).
    let balanceMethod = port.balanceMethod;
    if (balanceAdded) {
      balanceMethod = balanceAdded.name;
    } else if (balanceRemoved) {
      balanceMethod = upstreams.some((u) => u.weight > 1) ? "weighted" : "round_robin";
    } else if (serverEntries.length > 0 && !BALANCE_DIRECTIVE_NAMES.has(port.balanceMethod)) {
      balanceMethod = upstreams.some((u) => u.weight > 1) ? "weighted" : "round_robin";
    }

    if (JSON.stringify(upstreams) !== JSON.stringify(port.upstreams)) {
      edits.push({
        kind: "stream-field",
        index: idx,
        field: "upstreams",
        from: port.upstreams,
        to: upstreams,
        label: `streamPorts[${idx}].upstreams updated`,
      });
      for (const e of serverEntries) e.explained = true;
    }
    if (balanceMethod !== port.balanceMethod) {
      edits.push({
        kind: "stream-field",
        index: idx,
        field: "balanceMethod",
        from: port.balanceMethod,
        to: balanceMethod,
        label: `balanceMethod ${port.balanceMethod} → ${balanceMethod}`,
      });
      for (const e of entries) e.explained = true;
    }
  }

  // 6. Top-level anonymous `server` scope: listen (port/protocol) is
  // whitelisted; proxy_pass and anything else has no field to land in.
  const listenHandled = new Set<number>();
  const listenByIdx = new Map<number, StreamEntry[]>();
  const editedListenIdx = new Set<number>();
  for (const e of serverScopeEntries) {
    if (e.name !== "listen" && e.name !== "proxy_pass") {
      // Not a directive the model owns — but unlike `listen`/`proxy_pass`, an
      // arbitrary directive in this port's own `server {}` has somewhere to go.
      // An added line lands in the port's raw bucket; a *changed* or *removed*
      // one would mean rewriting text this classifier never rendered, so those
      // keep the refusal.
      const idx = e.kind === "added" ? portIndexFromServerScope(e.scopeKey) : null;
      if (idx !== null && idx < host.streamPorts.length && e.text) {
        const port = host.streamPorts[idx];
        const advanced = [port.advanced, e.text].filter(Boolean).join("\n");
        edits.push({
          kind: "stream-field",
          index: idx,
          field: "advanced",
          from: port.advanced ?? null,
          to: advanced,
          label: `${e.name} → Advanced (stream port ${port.port})`,
        });
        e.explained = true;
        continue;
      }
      refusals.push({ line: e.line, directive: e.name, reason: REASON_STREAM_UNMAPPABLE });
      e.explained = true;
      continue;
    }
    if (e.name === "proxy_pass") {
      refusals.push({ line: e.line, directive: e.name, reason: REASON_STREAM_UNMAPPABLE });
      e.explained = true;
      continue;
    }
    if (e.kind !== "changed" || !e.beforeArgs) {
      // An asymmetric listen add/remove (not paired with a matching change)
      // can't be safely attributed to one model port — refuse.
      refusals.push({ line: e.line, directive: "listen", reason: REASON_STREAM_UNMAPPABLE });
      e.explained = true;
      continue;
    }
    const before = parseListenLine(e.beforeArgs.join(" "));
    const idx = findStreamPortIndex(host, before.port, before.protocol);
    if (idx < 0) continue; // listen value matches no model port — swept below

    // Each stream port emits two `listen` lines (ipv4 + ipv6) that change
    // together — `listenHandled` collapses the pair into a single edit, so
    // both entries are marked explained together once an edit lands.
    if (!listenByIdx.has(idx)) listenByIdx.set(idx, []);
    listenByIdx.get(idx)!.push(e);
    if (listenHandled.has(idx)) continue;
    listenHandled.add(idx);

    const after = parseListenLine(e.args.join(" "));
    const port = host.streamPorts[idx];
    if (after.port !== port.port) {
      edits.push({
        kind: "stream-field",
        index: idx,
        field: "port",
        from: port.port,
        to: after.port,
        label: `listen ${port.port} → ${after.port}`,
      });
      editedListenIdx.add(idx);
    }
    if (after.protocol !== port.protocol) {
      edits.push({
        kind: "stream-field",
        index: idx,
        field: "protocol",
        from: port.protocol,
        to: after.protocol,
        label: `protocol ${port.protocol} → ${after.protocol}`,
      });
      editedListenIdx.add(idx);
    }
  }
  for (const idx of editedListenIdx) {
    for (const e of listenByIdx.get(idx) ?? []) e.explained = true;
  }

  // ── Final sweep: same barrier as the HTTP branch ─────────────────────────
  //
  // Reaching a bucket is not the same as being represented by it. A
  // `listen 5432 zzz_probe;` resolves to port 0 and then produces no edit
  // because the port and protocol both still match; an unparseable trailing
  // argument on a `server` line reconstructs to the identical upstream and
  // compares equal. In both cases the directive was recognised, its actual
  // change was dropped, and the old code returned an empty classification —
  // a silent save. Anything no branch marked `explained` is refused here.
  for (const e of allEntries) {
    if (e.explained) continue;
    refusals.push({ line: e.line, directive: e.name, reason: REASON_STREAM_UNMAPPABLE });
  }

  return { edits, refusals };
}
