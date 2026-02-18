import type { NgxConfig, NgxDirective } from "./ast";

export function render(config: NgxConfig, indentSize: number = 4): string {
  return renderDirectives(config.directives, 0, indentSize);
}

function renderDirectives(
  directives: NgxDirective[],
  depth: number,
  indentSize: number
): string {
  const lines: string[] = [];
  const indent = " ".repeat(depth * indentSize);

  for (const directive of directives) {
    // Comments
    if (directive.comments) {
      for (const comment of directive.comments) {
        lines.push(`${indent}${comment}`);
      }
    }

    if (directive.block) {
      // Block directive
      const argsStr =
        directive.args.length > 0 ? " " + directive.args.join(" ") : "";
      lines.push(`${indent}${directive.name}${argsStr} {`);
      const inner = renderDirectives(
        directive.block.directives,
        depth + 1,
        indentSize
      );
      if (inner.trim()) {
        for (const line of inner.trimEnd().split("\n")) {
          lines.push(line);
        }
      }
      lines.push(`${indent}}`);
    } else {
      // Simple directive
      const argsStr =
        directive.args.length > 0 ? " " + directive.args.join(" ") : "";
      lines.push(`${indent}${directive.name}${argsStr};`);
    }
  }

  return lines.join("\n") + "\n";
}
