import type { ClassifiedEdit, StreamHostConfig } from "./classify";
import type { HostConfig } from "~/lib/nginx/templates/server-block";

type Location = HostConfig["locations"][number];

/**
 * Merges one advanced line into an `advanced` field.
 *
 * With `replaces` the edit is a *changed* line: rewrite that entry in place, so
 * the old value does not survive alongside the new one. Without it the edit is
 * an addition and appends. See NUANCES §61.
 *
 * The fallback to append when `replaces` is not found keeps this a total
 * function — the classifier refuses that case before it gets here, but this
 * reducer must stay safe when handed edits classified against another state.
 */
function mergeText(existing: string | null | undefined, text: string, replaces?: string): string {
  if (replaces) {
    const want = replaces.trim();
    const lines = (existing ?? "").split("\n");
    const at = lines.findIndex((l) => l.trim() === want);
    if (at >= 0) {
      lines[at] = text;
      return lines.join("\n");
    }
  }
  return existing ? `${existing}\n${text}` : text;
}

/**
 * Pure reducer: applies a batch of classified edits to a HostConfig and
 * returns a new HostConfig. Never touches the DB or filesystem.
 *
 * Structural location edits (`location-removed`, `location-added`) are
 * deferred until after all index-addressed edits (`location-field`,
 * `location-advanced`) have been applied against the still-original-length
 * locations array, so indices in the same batch never shift underneath
 * each other.
 */
export function applyEdits(host: HostConfig, edits: ClassifiedEdit[]): HostConfig {
  let next: HostConfig = { ...host, locations: host.locations.map((loc) => ({ ...loc })) };

  const removedIndices = new Set<number>();
  const additions: Location[] = [];

  for (const edit of edits) {
    switch (edit.kind) {
      case "field":
        next = { ...next, [edit.field]: edit.to };
        break;

      case "location-field":
        next.locations[edit.index] = { ...next.locations[edit.index], [edit.field]: edit.to };
        break;

      case "location-advanced":
        next.locations[edit.index] = {
          ...next.locations[edit.index],
          advanced: mergeText(next.locations[edit.index].advanced, edit.text, edit.replaces),
        };
        break;

      case "location-removed":
        if (edit.index >= 0) removedIndices.add(edit.index);
        break;

      case "location-added":
        additions.push({
          path: edit.path,
          matchType: edit.matchType as Location["matchType"],
          type: edit.type as Location["type"],
          upstreams: [],
          balanceMethod: "round_robin",
          staticDir: "",
          cacheExpires: "",
          forwardScheme: "http",
          forwardDomain: "",
          forwardPath: "/",
          preservePath: true,
          statusCode: 301,
          headers: {},
          accessListId: null,
          basicAuth: null,
          advanced: edit.body,
        });
        break;

      case "prelude":
        // No `replaces` on prelude edits: a prelude ref can be a whole block
        // (an `upstream {...}` body), not a line, so line-wise replacement does
        // not apply. Still append-only — see NUANCES §61.
        next = { ...next, customPrelude: mergeText(next.customPrelude, edit.text) };
        break;

      case "server-advanced":
        next = { ...next, advancedNginx: mergeText(next.advancedNginx, edit.text, edit.replaces) };
        break;
    }
  }

  if (removedIndices.size > 0) {
    next = { ...next, locations: next.locations.filter((_, i) => !removedIndices.has(i)) };
  }
  if (additions.length > 0) {
    next = { ...next, locations: [...next.locations, ...additions] };
  }

  return next;
}

/**
 * Pure reducer for the stream branch (Task 8): applies a batch of
 * `stream-field` edits to a StreamHostConfig and returns a new one. Never
 * touches the DB or filesystem. `classifyStreamDelta` only ever produces
 * `stream-field` edits (plus refusals) for a stream file, so this ignores
 * any other edit kind defensively rather than asserting on it.
 */
export function applyStreamEdits(host: StreamHostConfig, edits: ClassifiedEdit[]): StreamHostConfig {
  let next: StreamHostConfig = {
    ...host,
    streamPorts: host.streamPorts.map((sp) => ({ ...sp, upstreams: sp.upstreams.map((u) => ({ ...u })) })),
  };

  for (const edit of edits) {
    if (edit.kind !== "stream-field") continue;
    next.streamPorts[edit.index] = { ...next.streamPorts[edit.index], [edit.field]: edit.to };
  }

  return next;
}
