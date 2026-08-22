import type { NgxConfig, NgxDirective } from "~/lib/nginx/parser/ast";
import { render } from "~/lib/nginx/parser/renderer";

export interface DirectiveRef {
  name: string;
  args: string[];
  line: number;
  /** Block ancestry from the file root, e.g. ["server", "location /api"] */
  scope: string[];
  /** Raw rendered text of this directive (with its block body, if any) */
  text: string;
}

export interface AstDelta {
  added: DirectiveRef[];
  removed: DirectiveRef[];
  changed: Array<{ before: DirectiveRef; after: DirectiveRef }>;
}

export function scopeKey(d: NgxDirective): string {
  return `${d.name} ${d.args.join(" ")}`.trim();
}

function toRef(d: NgxDirective, scope: string[]): DirectiveRef {
  return {
    name: d.name,
    args: d.args,
    line: d.line,
    scope,
    text: render({ directives: [{ ...d, comments: undefined }] }).trim(),
  };
}

export function diffAst(expected: NgxConfig, actual: NgxConfig): AstDelta {
  const delta: AstDelta = { added: [], removed: [], changed: [] };
  walk(expected.directives, actual.directives, [], delta);
  return delta;
}

/**
 * Pair sibling blocks by scope key, disambiguating duplicates by occurrence.
 *
 * An anonymous `server {}` has no args, so scopeKey() returns the bare "server"
 * for every one of them. Building a Map straight from those keys keeps only the
 * last sibling and drops the rest before they are ever compared — an edit to any
 * earlier sibling then produces an empty delta, i.e. no edit AND no refusal.
 * The first occurrence keeps the bare key so existing scope comparisons
 * (`scope[0] === "server"`) are unaffected; later ones get a "#N" suffix, which
 * also tells the stream classifier which port a delta belongs to.
 */
function indexBlocks(blocks: NgxDirective[]): Map<string, NgxDirective> {
  const seen = new Map<string, number>();
  const out = new Map<string, NgxDirective>();
  for (const d of blocks) {
    const base = scopeKey(d);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(n === 0 ? base : `${base}#${n}`, d);
  }
  return out;
}

/**
 * Directives whose first argument is an identity, not a value.
 *
 * Pairing these positionally makes a hand-inserted header masquerade as an edit
 * to an unrelated one: inserting `add_header X-Frame-Options DENY;` above an
 * existing `add_header X-Real-IP ...;` yields a bogus "changed" pair plus an
 * "added" leftover restating the untouched line, so one hand-written line
 * produces two edits and the second is fabricated (NUANCES §49). Same failure
 * shape as the block collapse above: identity replaced by position.
 */
const KEYED_DIRECTIVES = new Set(["add_header", "proxy_set_header"]);

/**
 * Key by first arg plus occurrence. The occurrence suffix matters: nginx allows
 * the same header twice (e.g. two `add_header Set-Cookie`), and a plain Map
 * keyed on the bare name would keep only the last and drop the first silently.
 */
function indexKeyed(list: NgxDirective[]): Map<string, NgxDirective> {
  const seen = new Map<string, number>();
  const out = new Map<string, NgxDirective>();
  for (const d of list) {
    const base = d.args[0] ?? "";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(n === 0 ? base : `${base}#${n}`, d);
  }
  return out;
}

function walk(
  expected: NgxDirective[],
  actual: NgxDirective[],
  scope: string[],
  delta: AstDelta
): void {
  const expBlocks = expected.filter((d) => d.block);
  const actBlocks = actual.filter((d) => d.block);
  const expSimple = expected.filter((d) => !d.block);
  const actSimple = actual.filter((d) => !d.block);

  // --- Block directives: pair by identity, recurse into matched bodies ---
  const expByKey = indexBlocks(expBlocks);
  const actByKey = indexBlocks(actBlocks);

  for (const [key, actDir] of actByKey) {
    const expDir = expByKey.get(key);
    if (!expDir) {
      delta.added.push(toRef(actDir, scope));
      continue;
    }
    walk(expDir.block!.directives, actDir.block!.directives, [...scope, key], delta);
  }
  for (const [key, expDir] of expByKey) {
    if (!actByKey.has(key)) delta.removed.push(toRef(expDir, scope));
  }

  // --- Simple directives: group by name, pair within the group ---
  const names = new Set([...expSimple.map((d) => d.name), ...actSimple.map((d) => d.name)]);
  for (const name of names) {
    const exp = expSimple.filter((d) => d.name === name);
    const act = actSimple.filter((d) => d.name === name);

    if (KEYED_DIRECTIVES.has(name)) {
      const expKeyed = indexKeyed(exp);
      const actKeyed = indexKeyed(act);
      for (const [key, a] of actKeyed) {
        const e = expKeyed.get(key);
        if (!e) {
          delta.added.push(toRef(a, scope));
        } else if (e.args.join(" ") !== a.args.join(" ")) {
          delta.changed.push({ before: toRef(e, scope), after: toRef(a, scope) });
        }
      }
      for (const [key, e] of expKeyed) {
        if (!actKeyed.has(key)) delta.removed.push(toRef(e, scope));
      }
      continue;
    }

    const shared = Math.min(exp.length, act.length);

    for (let i = 0; i < shared; i++) {
      if (exp[i].args.join(" ") !== act[i].args.join(" ")) {
        delta.changed.push({ before: toRef(exp[i], scope), after: toRef(act[i], scope) });
      }
    }
    for (let i = shared; i < act.length; i++) delta.added.push(toRef(act[i], scope));
    for (let i = shared; i < exp.length; i++) delta.removed.push(toRef(exp[i], scope));
  }
}
