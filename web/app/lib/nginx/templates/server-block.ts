import { buildUpstreamBlock } from "./upstream";
import { buildSslDirectives } from "./ssl";
import { buildAccessDirectives, type AccessListWithRules } from "./access";

export interface HostConfig {
  id: number;
  groupId: number | null;
  domains: string[];
  enabled: boolean;
  sslType: string;
  sslForceHttps: boolean;
  sslCertPath: string | null;
  sslKeyPath: string | null;
  hsts: boolean;
  http2: boolean;
  compression: boolean;
  redirectWww: boolean;
  clientMaxBodySize: string;
  locations: Array<{
    path: string;
    matchType: string;
    type: string;
    upstreams: Array<{ server: string; port: number; weight: number; protocol?: string }>;
    balanceMethod: string;
    staticDir: string;
    cacheExpires: string;
    forwardScheme: string;
    forwardDomain: string;
    forwardPath: string;
    preservePath: boolean;
    statusCode: number;
    headers: Record<string, string>;
    accessListId: number | null;
  }>;
  advancedNginx: string | null;
  webhookUrl: string | null;
  errorPagesDir: string | null;
}

/**
 * Builds a complete nginx config file for a host: upstream blocks + server block.
 */
export function buildServerBlock(
  host: HostConfig,
  accessLists: Map<number, AccessListWithRules>
): string {
  if (host.domains.length === 0) return "";

  const parts: string[] = [];
  const serverLines: string[] = [];
  const hasSsl = host.sslType !== "none";
  const primaryDomain = host.domains[0];

  // ── Upstream blocks for proxy locations ──
  const proxyLocations = (host.locations ?? []).filter(
    (l) => l.type === "proxy" && l.upstreams && l.upstreams.length > 0
  );
  for (let i = 0; i < (host.locations ?? []).length; i++) {
    const loc = host.locations[i];
    if (loc.type === "proxy" && loc.upstreams && loc.upstreams.length > 0) {
      const upstreamName = `host_${host.id}_loc_${i}`;
      const block = buildUpstreamBlock(
        upstreamName,
        loc.upstreams,
        loc.balanceMethod
      );
      if (block) parts.push(block);
    }
  }

  // ── Server block ──
  serverLines.push("server {");

  // Listen directives
  serverLines.push("    listen 80;");
  serverLines.push("    listen [::]:80;");

  if (hasSsl) {
    const http2Flag = host.http2 ? " http2" : "";
    serverLines.push(`    listen 443 ssl${http2Flag};`);
    serverLines.push(`    listen [::]:443 ssl${http2Flag};`);
  }

  // Server name
  serverLines.push(`    server_name ${host.domains.join(" ")};`);
  serverLines.push("");

  // Per-host access and error logs
  serverLines.push(
    `    access_log /data/logs/host-${host.id}_access.log main;`
  );
  serverLines.push(
    `    error_log /data/logs/host-${host.id}_error.log warn;`
  );
  serverLines.push("");

  // SSL directives
  if (hasSsl) {
    const sslBlock = buildSslDirectives(
      host.sslType,
      host.sslCertPath,
      host.sslKeyPath,
      primaryDomain
    );
    if (sslBlock) {
      serverLines.push(sslBlock);
      serverLines.push("");
    }
  }

  // Force HTTPS redirect
  if (hasSsl && host.sslForceHttps) {
    serverLines.push("    if ($scheme = http) {");
    serverLines.push("        return 301 https://$host$request_uri;");
    serverLines.push("    }");
    serverLines.push("");
  }

  // WWW redirect
  if (host.redirectWww) {
    // If server_name includes both www and non-www, add a redirect
    const hasWww = host.domains.some((d) => d.startsWith("www."));
    const hasNonWww = host.domains.some((d) => !d.startsWith("www."));
    if (hasWww && hasNonWww) {
      const nonWwwDomain = host.domains.find((d) => !d.startsWith("www."));
      if (nonWwwDomain) {
        serverLines.push("    if ($host ~ ^www\\.(.+)$) {");
        serverLines.push(
          `        return 301 $scheme://${nonWwwDomain}$request_uri;`
        );
        serverLines.push("    }");
        serverLines.push("");
      }
    }
  }

  // HSTS
  if (hasSsl && host.hsts) {
    serverLines.push(
      '    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;'
    );
    serverLines.push("");
  }

  // Compression
  if (host.compression) {
    serverLines.push("    gzip on;");
    serverLines.push("    gzip_vary on;");
    serverLines.push("    gzip_proxied any;");
    serverLines.push("    gzip_comp_level 6;");
    serverLines.push(
      "    gzip_types text/plain text/css text/xml application/json application/javascript application/xml+rss application/atom+xml image/svg+xml;"
    );
    serverLines.push("");
  }

  // Client max body size
  if (host.clientMaxBodySize && host.clientMaxBodySize !== "1m") {
    serverLines.push(`    client_max_body_size ${host.clientMaxBodySize};`);
    serverLines.push("");
  }

  // Error pages
  if (host.errorPagesDir) {
    serverLines.push(`    error_page 404 /custom_404.html;`);
    serverLines.push(`    error_page 500 502 503 504 /custom_50x.html;`);
    serverLines.push("");
    serverLines.push("    location = /custom_404.html {");
    serverLines.push(`        root ${host.errorPagesDir};`);
    serverLines.push("        internal;");
    serverLines.push("    }");
    serverLines.push("");
    serverLines.push("    location = /custom_50x.html {");
    serverLines.push(`        root ${host.errorPagesDir};`);
    serverLines.push("        internal;");
    serverLines.push("    }");
    serverLines.push("");
  }

  // ACME challenge location (always present if SSL or for future provisioning)
  serverLines.push("    location /.well-known/acme-challenge/ {");
  serverLines.push("        alias /data/acme-challenge/;");
  serverLines.push("    }");
  serverLines.push("");

  // ── Location blocks ──
  for (let i = 0; i < (host.locations ?? []).length; i++) {
    const loc = host.locations[i];
    const locationDirective = buildLocationDirective(loc.path, loc.matchType);
    serverLines.push(`    ${locationDirective} {`);

    // Access control for this location
    if (loc.accessListId && accessLists.has(loc.accessListId)) {
      const acl = accessLists.get(loc.accessListId)!;
      serverLines.push(buildAccessDirectives(acl));
      serverLines.push("");
    }

    switch (loc.type) {
      case "proxy": {
        if (loc.upstreams && loc.upstreams.length > 0) {
          const upstreamName = `host_${host.id}_loc_${i}`;
          const protocol = loc.upstreams[0]?.protocol || "http";

          switch (protocol) {
            case "grpc":
              serverLines.push(`        grpc_pass grpc://${upstreamName};`);
              break;
            case "grpcs":
              serverLines.push(`        grpc_pass grpcs://${upstreamName};`);
              break;
            case "fastcgi": {
              serverLines.push(`        fastcgi_pass ${upstreamName};`);
              serverLines.push("        include fastcgi_params;");
              serverLines.push("        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;");
              break;
            }
            case "http":
            case "https":
            default:
              serverLines.push(`        proxy_pass ${protocol}://${upstreamName};`);
              break;
          }

          // Headers differ by protocol
          if (protocol !== "grpc" && protocol !== "grpcs" && protocol !== "fastcgi") {
            serverLines.push("        proxy_set_header Host $host;");
            serverLines.push(
              "        proxy_set_header X-Real-IP $remote_addr;"
            );
            serverLines.push(
              "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"
            );
            serverLines.push(
              "        proxy_set_header X-Forwarded-Proto $scheme;"
            );
            serverLines.push("        proxy_http_version 1.1;");
            serverLines.push(
              '        proxy_set_header Upgrade $http_upgrade;'
            );
            serverLines.push(
              '        proxy_set_header Connection "upgrade";'
            );
          }
        }
        break;
      }
      case "static": {
        if (loc.staticDir) {
          serverLines.push(`        alias ${loc.staticDir};`);
        }
        if (loc.cacheExpires) {
          serverLines.push(`        expires ${loc.cacheExpires};`);
          serverLines.push(
            '        add_header Cache-Control "public, no-transform";'
          );
        }
        serverLines.push("        try_files $uri $uri/ =404;");
        break;
      }
      case "redirect": {
        const scheme = loc.forwardScheme || "https";
        const domain = loc.forwardDomain || "$host";
        const path = loc.forwardPath || "/";
        const statusCode = loc.statusCode || 301;

        if (loc.preservePath) {
          serverLines.push(
            `        return ${statusCode} ${scheme}://${domain}$request_uri;`
          );
        } else {
          serverLines.push(
            `        return ${statusCode} ${scheme}://${domain}${path};`
          );
        }
        break;
      }
    }

    // Custom headers
    if (loc.headers && Object.keys(loc.headers).length > 0) {
      for (const [key, value] of Object.entries(loc.headers)) {
        serverLines.push(`        add_header ${key} "${value}";`);
      }
    }

    serverLines.push("    }");
    serverLines.push("");
  }

  // Advanced nginx directives (raw)
  if (host.advancedNginx) {
    serverLines.push("    # Advanced directives");
    // Indent each line with 4 spaces
    const advLines = host.advancedNginx.split("\n");
    for (const line of advLines) {
      serverLines.push(`    ${line}`);
    }
    serverLines.push("");
  }

  serverLines.push("}");

  parts.push(serverLines.join("\n"));

  return (
    `# Host: ${host.domains.join(", ")} (ID: ${host.id})\n` +
    `# Auto-generated by Nginx Manager. Do not edit manually.\n\n` +
    parts.join("\n\n")
  );
}

/**
 * Builds the nginx location directive based on match type.
 */
function buildLocationDirective(path: string, matchType: string): string {
  switch (matchType) {
    case "exact":
      return `location = ${path}`;
    case "regex":
      return `location ~ ${path}`;
    case "prefix":
    default:
      return `location ${path}`;
  }
}
