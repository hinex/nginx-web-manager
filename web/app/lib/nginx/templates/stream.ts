import { buildUpstreamBlock } from "./upstream";

/**
 * Generates nginx stream blocks for TCP/UDP proxying.
 */
export function buildStreamBlock(
  hostId: number,
  streamPorts: Array<{
    port: number;
    protocol: string;
    upstreams: Array<{ server: string; port: number; weight: number }>;
    balanceMethod: string;
    /**
     * Raw directives for this port's `server {}` block — the stream twin of a
     * location's `advanced` body. Without it, a legitimate directive nginx
     * supports here (`proxy_timeout`, `proxy_protocol`, …) could be refused
     * forever with no way to apply it. Deliberately scoped to the port's own
     * `server` block: adding or removing a whole `server`/`upstream`, or
     * editing `listen`, stays a refusal, so the structural guarantees this
     * subsystem exists for are untouched.
     */
    advanced?: string | null;
  }>,
  dnsResolver?: string | null,
  dnsResolverValid?: string | null
): string {
  if (streamPorts.length === 0) return "";

  const blocks: string[] = [];

  for (let i = 0; i < streamPorts.length; i++) {
    const sp = streamPorts[i];
    if (sp.upstreams.length === 0) continue;

    const upstreamName = `stream_host_${hostId}_port_${i}`;
    // Dynamic DNS (single upstream + resolver): variable proxy_pass so nginx
    // re-resolves the hostname at runtime instead of caching the IP at config load.
    const useVariable = !!dnsResolver && sp.upstreams.length === 1;

    if (!useVariable) {
      // Upstream block
      blocks.push(
        buildUpstreamBlock(upstreamName, sp.upstreams, sp.balanceMethod)
      );
    }

    // Server block
    const lines: string[] = [];
    lines.push("server {");

    if (sp.protocol === "udp") {
      lines.push(`    listen ${sp.port} udp;`);
      lines.push(`    listen [::]:${sp.port} udp;`);
    } else {
      lines.push(`    listen ${sp.port};`);
      lines.push(`    listen [::]:${sp.port};`);
    }

    if (useVariable) {
      const u = sp.upstreams[0];
      lines.push(`    resolver ${dnsResolver} valid=${dnsResolverValid || "30s"};`);
      lines.push(`    set $backend_${upstreamName} "${u.server}:${u.port}";`);
      lines.push(`    proxy_pass $backend_${upstreamName};`);
    } else {
      lines.push(`    proxy_pass ${upstreamName};`);
    }

    // Raw escape hatch, emitted last so it can override the generated
    // directives above (same ordering rule as a location's advanced body).
    if (sp.advanced) {
      for (const line of sp.advanced.split("\n")) {
        lines.push(`    ${line}`);
      }
    }
    lines.push("}");

    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}
