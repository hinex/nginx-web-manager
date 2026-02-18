import { builtinTemplateStrings } from "./builtin";

export interface TemplateVariable {
  name: string;
  label: string;
  type: "string" | "number" | "boolean";
  default?: string | number | boolean;
}

export interface TemplateMeta {
  name: string;
  description: string;
  category: string;
  variables: TemplateVariable[];
}

export interface Template {
  meta: TemplateMeta;
  body: string;
}

/**
 * Parse a template file consisting of YAML-like frontmatter + body.
 * Frontmatter is delimited by --- lines.
 */
export function parseTemplate(raw: string): Template {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("Invalid template: missing frontmatter");

  const frontmatter = match[1];
  const body = match[2];

  const meta = parseFrontmatter(frontmatter);

  return { meta, body: body.trim() };
}

/**
 * Render a template with variable values using simple Mustache-like syntax.
 *
 * Supports:
 *   {{var}}         — simple substitution
 *   {{#var}}...{{/var}} — truthy boolean section (included when var is true)
 *   {{^var}}...{{/var}} — falsy boolean section  (included when var is false)
 */
export function renderTemplate(
  template: Template,
  values: Record<string, string | number | boolean>
): string {
  let output = template.body;

  // Handle boolean sections first
  for (const v of template.meta.variables) {
    if (v.type === "boolean") {
      const val = values[v.name] ?? v.default ?? false;
      const truthyRegex = new RegExp(
        `\\{\\{#${v.name}\\}\\}([\\s\\S]*?)\\{\\{/${v.name}\\}\\}`,
        "g"
      );
      const falsyRegex = new RegExp(
        `\\{\\{\\^${v.name}\\}\\}([\\s\\S]*?)\\{\\{/${v.name}\\}\\}`,
        "g"
      );

      output = output.replace(truthyRegex, val ? "$1" : "");
      output = output.replace(falsyRegex, val ? "" : "$1");
    }
  }

  // Handle simple variable substitution
  for (const v of template.meta.variables) {
    const val = values[v.name] ?? v.default ?? "";
    output = output.replace(
      new RegExp(`\\{\\{${v.name}\\}\\}`, "g"),
      String(val)
    );
  }

  return output;
}

/**
 * Return all built-in templates, parsed and ready for use.
 */
export function getBuiltinTemplates(): Template[] {
  return builtinTemplateStrings.map((raw) => parseTemplate(raw));
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Minimal YAML-like parser for the template frontmatter.
 *
 * Handles:
 *   key: value           — simple scalars
 *   variables:           — array of objects (items start with "  - ")
 *     - name: …
 *       label: …
 */
function parseFrontmatter(text: string): TemplateMeta {
  const lines = text.split("\n");

  let name = "";
  let description = "";
  let category = "";
  const variables: TemplateVariable[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Top-level key: value
    const kvMatch = line.match(/^(\w+):\s*(.+)$/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      switch (key) {
        case "name":
          name = value.trim();
          break;
        case "description":
          description = value.trim();
          break;
        case "category":
          category = value.trim();
          break;
      }
      i++;
      continue;
    }

    // Start of variables list
    if (line.match(/^variables:\s*$/)) {
      i++;
      // Parse each list item
      while (i < lines.length && lines[i].match(/^\s+-\s/)) {
        const variable = parseVariableBlock(lines, i);
        variables.push(variable.value);
        i = variable.nextIndex;
      }
      continue;
    }

    i++;
  }

  if (!name) throw new Error("Invalid template frontmatter: missing name");

  return { name, description, category, variables };
}

function parseVariableBlock(
  lines: string[],
  startIndex: number
): { value: TemplateVariable; nextIndex: number } {
  const result: Record<string, string> = {};

  // First line: "  - key: value"
  const firstMatch = lines[startIndex].match(/^\s+-\s+(\w+):\s*(.*)$/);
  if (firstMatch) {
    result[firstMatch[1]] = firstMatch[2].trim();
  }

  let i = startIndex + 1;

  // Continuation lines: "    key: value" (indented, no dash)
  while (i < lines.length) {
    const contMatch = lines[i].match(/^\s{4,}(\w+):\s*(.*)$/);
    if (contMatch && !lines[i].match(/^\s+-\s/)) {
      result[contMatch[1]] = contMatch[2].trim();
      i++;
    } else {
      break;
    }
  }

  const variable: TemplateVariable = {
    name: result.name || "",
    label: result.label || "",
    type: (result.type as TemplateVariable["type"]) || "string",
  };

  if (result.default !== undefined && result.default !== "") {
    if (variable.type === "number") {
      variable.default = Number(result.default);
    } else if (variable.type === "boolean") {
      variable.default = result.default === "true";
    } else {
      variable.default = result.default;
    }
  }

  return { value: variable, nextIndex: i };
}
