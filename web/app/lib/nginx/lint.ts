import { parse, type NgxDirective } from "./parser/ast";

/**
 * A non-blocking finding about config text: the save still goes through,
 * the operator is just told about a likely mistake. Refusals block; warnings
 * never do.
 */
export interface ConfigWarning {
  line: number;
  message: string;
}

/** Cache lifetimes at or above this are "long" — an hour of a cached 500 already hurts. */
const LONG_CACHE_SECONDS = 3600;

function unquote(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.endsWith(first) && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

function isLongLivedCacheControl(value: string): boolean {
  const lower = value.toLowerCase();
  if (/\bimmutable\b/.test(lower)) return true;
  for (const match of lower.matchAll(/\b(?:s-)?max-?age\s*=\s*(\d+)/g)) {
    if (Number(match[1]) >= LONG_CACHE_SECONDS) return true;
  }
  return false;
}

/**
 * `add_header ... always` attaches the header to error responses too. With a
 * long-lived Cache-Control that tells a CDN (Cloudflare) to keep a 404/500 for
 * the whole max-age — seen in production: a transient 500 on /assets/ kept
 * being served from the CDN after the config was already fixed.
 */
function cacheControlAlways(d: NgxDirective): ConfigWarning | null {
  if (d.name !== "add_header" || d.args.length < 3) return null;
  if (unquote(d.args[0]).toLowerCase() !== "cache-control") return null;
  if (d.args[d.args.length - 1] !== "always") return null;
  const value = unquote(d.args[1]);
  if (!isLongLivedCacheControl(value)) return null;
  return {
    line: d.line,
    message:
      `add_header Cache-Control "${value}" always also marks error responses (404, 500) as cacheable — ` +
      `a CDN or browser will keep serving the error for the whole cache lifetime. ` +
      `Drop "always" unless errors should be cached too.`,
  };
}

const RULES: Array<(d: NgxDirective) => ConfigWarning | null> = [cacheControlAlways];

/**
 * Lints nginx config text (a whole file, or a fragment such as a location's
 * advanced body). Text that does not parse yields no warnings — syntax is
 * `nginx -t`'s job, and a linter that throws would block the save it is
 * only meant to annotate.
 */
export function lintConfig(text: string): ConfigWarning[] {
  let directives: NgxDirective[];
  try {
    directives = parse(text).directives;
  } catch {
    return [];
  }
  const warnings: ConfigWarning[] = [];
  const walk = (list: NgxDirective[]) => {
    for (const d of list) {
      for (const rule of RULES) {
        const warning = rule(d);
        if (warning) warnings.push(warning);
      }
      if (d.block) walk(d.block.directives);
    }
  };
  walk(directives);
  return warnings;
}
