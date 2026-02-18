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
  }>
): string {
  if (streamPorts.length === 0) return "";

  const blocks: string[] = [];

  for (let i = 0; i < streamPorts.length; i++) {
    const sp = streamPorts[i];
    if (sp.upstreams.length === 0) continue;

    const upstreamName = `stream_host_${hostId}_port_${i}`;

    // Upstream block
    blocks.push(
      buildUpstreamBlock(upstreamName, sp.upstreams, sp.balanceMethod)
    );

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

    lines.push(`    proxy_pass ${upstreamName};`);
    lines.push("}");

    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}
