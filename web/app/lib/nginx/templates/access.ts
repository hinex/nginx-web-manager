/**
 * Generates nginx access control directives and htpasswd content.
 */

export interface AccessListWithRules {
  id: number;
  name: string;
  satisfy: string;
  clients: Array<{ address: string; directive: string }>;
  auth: Array<{ username: string; password: string }>;
}

/**
 * Builds inline access control directives for a location block.
 */
export function buildAccessDirectives(accessList: AccessListWithRules): string {
  const lines: string[] = [];

  const hasClients = accessList.clients.length > 0;
  const hasAuth = accessList.auth.length > 0;

  // satisfy directive only matters when both IP and auth rules exist
  if (hasClients && hasAuth) {
    lines.push(`    satisfy ${accessList.satisfy};`);
  }

  // IP allow/deny rules
  for (const client of accessList.clients) {
    lines.push(`    ${client.directive} ${client.address};`);
  }
  if (hasClients) {
    lines.push("    deny all;");
  }

  // Basic auth
  if (hasAuth) {
    lines.push(`    auth_basic "Restricted";`);
    lines.push(
      `    auth_basic_user_file /data/nginx/auth/access-list-${accessList.id}.htpasswd;`
    );
  }

  return lines.join("\n");
}

/**
 * Builds htpasswd file content for basic auth.
 * Passwords are expected to already be hashed (bcrypt from Bun.password.hash).
 */
export function buildHtpasswdContent(
  authEntries: Array<{ username: string; password: string }>
): string {
  return authEntries
    .map((entry) => `${entry.username}:${entry.password}`)
    .join("\n");
}
