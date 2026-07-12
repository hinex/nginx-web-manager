/**
 * validatePublishData — verbatim port of the publish-time validation block from
 * web/app/routes/admin/hosts/edit.tsx (lines 104-165).
 *
 * Returns an error string, or null when the data is valid.
 */

export interface ValidatableLocation {
  path: string;
  matchType?: string;
  type: string;
  upstreams?: Array<{ server?: string; port?: number; protocol?: string }>;
  staticDir?: string;
  forwardDomain?: string;
}

export interface ValidatableStreamPort {
  port?: number | null;
  upstreams?: unknown[];
}

export interface ValidatableData {
  domains?: string[];
  locations: ValidatableLocation[];
  streamPorts: ValidatableStreamPort[];
  sslType?: string;
  sslCertPath?: string;
  sslKeyPath?: string;
}

export function validatePublishData(data: ValidatableData): string | null {
  const hasHttpLocations = data.locations.length > 0;
  if (hasHttpLocations && (!data.domains || data.domains.length === 0)) {
    return "At least one domain is required for HTTP locations";
  }

  if (data.locations.length === 0 && data.streamPorts.length === 0) {
    return "At least one location or stream port is required";
  }

  // Validate no duplicate location paths
  const locationKeys = data.locations.map((l) => {
    const prefix = l.matchType === "exact" ? "= " : l.matchType === "regex" ? "~ " : "";
    return `${prefix}${l.path}`;
  });
  const seen = new Set<string>();
  for (const key of locationKeys) {
    if (seen.has(key)) {
      return `Duplicate location "${key}". Each location path + match type must be unique.`;
    }
    seen.add(key);
  }

  for (const loc of data.locations) {
    if (loc.type === "proxy") {
      if (!loc.upstreams || loc.upstreams.length === 0) {
        return `Proxy location "${loc.path}" needs at least one upstream`;
      }
      for (const u of loc.upstreams) {
        if (!u.server?.trim()) return "All upstreams must have a server address";
        if (!u.port || u.port < 1 || u.port > 65535) return "Upstream port must be 1-65535";
      }
      // Validate all upstreams in a location use the same protocol
      const protocols = new Set(loc.upstreams.map((u) => u.protocol || "http"));
      if (protocols.size > 1) {
        return `Proxy location "${loc.path}" has mixed upstream protocols. All upstreams in a location must use the same protocol.`;
      }
    }
    if (loc.type === "static") {
      if (!loc.staticDir?.trim()) return `Static location "${loc.path}" needs a directory path`;
    }
    if (loc.type === "redirect") {
      if (!loc.forwardDomain?.trim()) return `Redirect location "${loc.path}" needs a forward domain`;
    }
    if (loc.type === "file") {
      if (!loc.staticDir?.trim()) return `File location "${loc.path}" needs a file path`;
    }
  }

  for (const sp of data.streamPorts) {
    if (!sp.port || sp.port < 1 || sp.port > 65535) {
      return "Stream port must be 1-65535";
    }
    if (!sp.upstreams || sp.upstreams.length === 0) {
      return `Stream port ${sp.port} needs at least one upstream`;
    }
  }

  if (data.sslType === "custom" && (!data.sslCertPath || !data.sslKeyPath)) {
    return "Custom SSL requires both certificate and key paths";
  }

  return null;
}
