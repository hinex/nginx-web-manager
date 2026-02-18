import { template as reverseProxy } from "./reverse-proxy";
import { template as sslReverseProxy } from "./ssl-reverse-proxy";
import { template as staticSite } from "./static-site";
import { template as websocketProxy } from "./websocket-proxy";
import { template as loadBalancer } from "./load-balancer";
import { template as phpFpm } from "./php-fpm";
import { template as spa } from "./spa";
import { template as redirect } from "./redirect";
import { template as rateLimit } from "./rate-limit";
import { template as securityHeaders } from "./security-headers";

/**
 * All built-in template strings in one array.
 * Each entry is the raw template text (frontmatter + body).
 */
export const builtinTemplateStrings: string[] = [
  reverseProxy,
  sslReverseProxy,
  staticSite,
  websocketProxy,
  loadBalancer,
  phpFpm,
  spa,
  redirect,
  rateLimit,
  securityHeaders,
];
