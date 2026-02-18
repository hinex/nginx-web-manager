/**
 * Generates SSL/TLS directives for an nginx server block.
 */
export function buildSslDirectives(
  sslType: string,
  certPath: string | null,
  keyPath: string | null,
  domain: string
): string {
  if (sslType === "none") return "";

  const lines: string[] = [];

  if (sslType === "letsencrypt") {
    const cert = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
    const key = `/etc/letsencrypt/live/${domain}/privkey.pem`;
    lines.push(`    ssl_certificate ${cert};`);
    lines.push(`    ssl_certificate_key ${key};`);
  } else if (sslType === "custom" && certPath && keyPath) {
    lines.push(`    ssl_certificate ${certPath};`);
    lines.push(`    ssl_certificate_key ${keyPath};`);
  }

  lines.push("    ssl_protocols TLSv1.2 TLSv1.3;");
  lines.push("    ssl_ciphers HIGH:!aNULL:!MD5;");
  lines.push("    ssl_prefer_server_ciphers on;");
  lines.push("    ssl_session_cache shared:SSL:10m;");
  lines.push("    ssl_session_timeout 10m;");

  return lines.join("\n");
}
