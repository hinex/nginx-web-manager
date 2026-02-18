/**
 * Generates nginx `upstream` blocks for load balancing.
 */
export function buildUpstreamBlock(
  name: string,
  upstreams: Array<{ server: string; port: number; weight: number }>,
  balanceMethod: string
): string {
  if (upstreams.length === 0) return "";

  const lines: string[] = [];
  lines.push(`upstream ${name} {`);

  // Balance method directive
  switch (balanceMethod) {
    case "least_conn":
      lines.push("    least_conn;");
      break;
    case "ip_hash":
      lines.push("    ip_hash;");
      break;
    case "random":
      lines.push("    random;");
      break;
    // round_robin is default — no directive needed
    // weighted uses weight= on server lines
  }

  for (const u of upstreams) {
    const weight =
      balanceMethod === "weighted" && u.weight > 1
        ? ` weight=${u.weight}`
        : "";
    lines.push(`    server ${u.server}:${u.port}${weight};`);
  }

  lines.push("}");
  return lines.join("\n");
}
