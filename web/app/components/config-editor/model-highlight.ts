import { parse } from "~/lib/nginx/parser/ast";
import type { NgxDirective } from "~/lib/nginx/parser/ast";
import { SERVER_FIELDS, LOCATION_FIELDS } from "~/lib/nginx/reverse/classify";

// Re-exported, not reimplemented: the live syntax diagnostic wired into
// CodeEditor.tsx must reuse this exact scanner (design record §refusal 6),
// never a second implementation. See ~/lib/nginx/reverse/syntax.ts.
export { syntaxError, type SyntaxProblem } from "~/lib/nginx/reverse/syntax";

export interface ModelLine {
  line: number;
  field: string;
}

/**
 * Pure line -> host-field map for editor highlighting.
 *
 * Uses the *same* whitelist tables the classifier (`~/lib/nginx/reverse/classify.ts`)
 * checks a saved edit against — imported, never restated — so a line the
 * editor marks as "model-owned" can never be a line the classifier would
 * actually refuse or dump into an Advanced escape hatch.
 *
 * Pure TypeScript only: no `fs`, no `bun:sqlite`. Leaf imports only from the
 * parser (`~/lib/nginx/parser/ast`), never the barrel (`~/lib/nginx/parser`),
 * which pulls Node's `fs` in at module load.
 */
export function modelLines(content: string): ModelLine[] {
  const config = parse(content);
  const result: ModelLine[] = [];

  for (const top of config.directives) {
    if (top.name === "server" && top.block) {
      walkServer(top.block.directives, result);
    }
  }

  return result;
}

function walkServer(directives: NgxDirective[], out: ModelLine[]): void {
  let locationIndex = 0;

  for (const d of directives) {
    if (d.name === "location" && d.block) {
      const index = locationIndex++;
      walkLocation(d.block.directives, index, out);
      continue;
    }

    if (d.block) continue; // other server-scope blocks (e.g. `if {}`) carry no single whitelisted field

    const entry = SERVER_FIELDS[d.name];
    if (entry) out.push({ line: d.line, field: entry.field });
  }
}

function walkLocation(directives: NgxDirective[], index: number, out: ModelLine[]): void {
  for (const d of directives) {
    if (d.block) continue;

    const entry = LOCATION_FIELDS[d.name];
    if (entry) out.push({ line: d.line, field: `locations[${index}].${entry.field}` });
  }
}
