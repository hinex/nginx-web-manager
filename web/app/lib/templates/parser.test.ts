import { describe, it, expect } from "vitest";
import {
  parseTemplate,
  renderTemplate,
  getBuiltinTemplates,
  type Template,
} from "./parser";

// ── parseTemplate ──────────────────────────────────────────────────

describe("parseTemplate", () => {
  it("parses valid frontmatter and body", () => {
    const raw = `---
name: Test Template
description: A test template
category: test
variables:
  - name: host
    label: Hostname
    type: string
    default: localhost
  - name: port
    label: Port
    type: number
    default: 8080
---
server {
    listen {{port}};
    server_name {{host}};
}`;

    const result = parseTemplate(raw);

    expect(result.meta.name).toBe("Test Template");
    expect(result.meta.description).toBe("A test template");
    expect(result.meta.category).toBe("test");
    expect(result.meta.variables).toHaveLength(2);
    expect(result.meta.variables[0]).toEqual({
      name: "host",
      label: "Hostname",
      type: "string",
      default: "localhost",
    });
    expect(result.meta.variables[1]).toEqual({
      name: "port",
      label: "Port",
      type: "number",
      default: 8080,
    });
    expect(result.body).toContain("server {");
    expect(result.body).toContain("{{port}}");
  });

  it("parses boolean variable defaults correctly", () => {
    const raw = `---
name: Bool Test
description: Test boolean parsing
category: test
variables:
  - name: ssl
    label: Enable SSL
    type: boolean
    default: true
  - name: debug
    label: Debug Mode
    type: boolean
    default: false
---
body`;

    const result = parseTemplate(raw);

    expect(result.meta.variables[0].default).toBe(true);
    expect(result.meta.variables[1].default).toBe(false);
  });

  it("handles variables with no default", () => {
    const raw = `---
name: No Defaults
description: Variables without defaults
category: test
variables:
  - name: domain
    label: Domain
    type: string
---
server_name {{domain}};`;

    const result = parseTemplate(raw);

    expect(result.meta.variables[0].name).toBe("domain");
    expect(result.meta.variables[0].default).toBeUndefined();
  });

  it("throws on missing frontmatter", () => {
    expect(() => parseTemplate("no frontmatter here")).toThrow(
      "Invalid template: missing frontmatter"
    );
  });

  it("throws on empty string", () => {
    expect(() => parseTemplate("")).toThrow(
      "Invalid template: missing frontmatter"
    );
  });

  it("throws on frontmatter without name", () => {
    const raw = `---
description: No name
category: test
variables:
---
body`;

    expect(() => parseTemplate(raw)).toThrow("missing name");
  });

  it("parses multiple variables correctly", () => {
    const raw = `---
name: Multi Var
description: Many variables
category: test
variables:
  - name: a
    label: A
    type: string
    default: alpha
  - name: b
    label: B
    type: number
    default: 42
  - name: c
    label: C
    type: boolean
    default: true
  - name: d
    label: D
    type: string
    default: delta
---
{{a}} {{b}} {{c}} {{d}}`;

    const result = parseTemplate(raw);
    expect(result.meta.variables).toHaveLength(4);
    expect(result.meta.variables[0].default).toBe("alpha");
    expect(result.meta.variables[1].default).toBe(42);
    expect(result.meta.variables[2].default).toBe(true);
    expect(result.meta.variables[3].default).toBe("delta");
  });
});

// ── renderTemplate ─────────────────────────────────────────────────

describe("renderTemplate", () => {
  const baseTemplate: Template = {
    meta: {
      name: "Test",
      description: "Test",
      category: "test",
      variables: [
        { name: "host", label: "Host", type: "string", default: "localhost" },
        { name: "port", label: "Port", type: "number", default: 3000 },
      ],
    },
    body: "server {\n    listen {{port}};\n    server_name {{host}};\n}",
  };

  it("replaces string variables", () => {
    const result = renderTemplate(baseTemplate, {
      host: "example.com",
      port: 8080,
    });
    expect(result).toContain("server_name example.com;");
    expect(result).toContain("listen 8080;");
  });

  it("uses default values when not provided", () => {
    const result = renderTemplate(baseTemplate, {});
    expect(result).toContain("server_name localhost;");
    expect(result).toContain("listen 3000;");
  });

  it("handles partial values (uses defaults for missing)", () => {
    const result = renderTemplate(baseTemplate, { host: "myhost.com" });
    expect(result).toContain("server_name myhost.com;");
    expect(result).toContain("listen 3000;");
  });

  it("replaces multiple occurrences of the same variable", () => {
    const tpl: Template = {
      meta: {
        name: "Multi",
        description: "",
        category: "test",
        variables: [
          { name: "domain", label: "Domain", type: "string", default: "example.com" },
        ],
      },
      body: "server_name {{domain}};\nssl_certificate /etc/ssl/{{domain}}/cert.pem;",
    };
    const result = renderTemplate(tpl, { domain: "test.org" });
    expect(result).toContain("server_name test.org;");
    expect(result).toContain("/etc/ssl/test.org/cert.pem");
  });

  it("renders truthy boolean sections", () => {
    const tpl: Template = {
      meta: {
        name: "Bool",
        description: "",
        category: "test",
        variables: [
          { name: "ssl", label: "SSL", type: "boolean", default: false },
        ],
      },
      body: "{{#ssl}}ssl on;{{/ssl}}{{^ssl}}ssl off;{{/ssl}}",
    };

    const withSsl = renderTemplate(tpl, { ssl: true });
    expect(withSsl).toContain("ssl on;");
    expect(withSsl).not.toContain("ssl off;");
  });

  it("renders falsy boolean sections", () => {
    const tpl: Template = {
      meta: {
        name: "Bool",
        description: "",
        category: "test",
        variables: [
          { name: "ssl", label: "SSL", type: "boolean", default: true },
        ],
      },
      body: "{{#ssl}}ssl on;{{/ssl}}{{^ssl}}ssl off;{{/ssl}}",
    };

    const withoutSsl = renderTemplate(tpl, { ssl: false });
    expect(withoutSsl).toContain("ssl off;");
    expect(withoutSsl).not.toContain("ssl on;");
  });

  it("uses boolean default when value not provided", () => {
    const tpl: Template = {
      meta: {
        name: "Default Bool",
        description: "",
        category: "test",
        variables: [
          { name: "gzip", label: "Gzip", type: "boolean", default: true },
        ],
      },
      body: "{{#gzip}}gzip on;{{/gzip}}{{^gzip}}gzip off;{{/gzip}}",
    };

    const result = renderTemplate(tpl, {});
    expect(result).toContain("gzip on;");
    expect(result).not.toContain("gzip off;");
  });

  it("handles mixed boolean and string variables", () => {
    const tpl: Template = {
      meta: {
        name: "Mixed",
        description: "",
        category: "test",
        variables: [
          { name: "domain", label: "Domain", type: "string", default: "example.com" },
          { name: "ssl", label: "SSL", type: "boolean", default: true },
          { name: "port", label: "Port", type: "number", default: 443 },
        ],
      },
      body: "server_name {{domain}};\n{{#ssl}}listen {{port}} ssl;{{/ssl}}{{^ssl}}listen 80;{{/ssl}}",
    };

    const result = renderTemplate(tpl, { domain: "mysite.com", ssl: true, port: 8443 });
    expect(result).toContain("server_name mysite.com;");
    expect(result).toContain("listen 8443 ssl;");
    expect(result).not.toContain("listen 80;");
  });
});

// ── getBuiltinTemplates ────────────────────────────────────────────

describe("getBuiltinTemplates", () => {
  it("returns all 10 built-in templates", () => {
    const templates = getBuiltinTemplates();
    expect(templates).toHaveLength(10);
  });

  it("each template has required meta fields", () => {
    const templates = getBuiltinTemplates();
    for (const t of templates) {
      expect(t.meta.name).toBeTruthy();
      expect(t.meta.description).toBeTruthy();
      expect(t.meta.category).toBeTruthy();
      expect(Array.isArray(t.meta.variables)).toBe(true);
      expect(t.meta.variables.length).toBeGreaterThan(0);
    }
  });

  it("each template has a non-empty body", () => {
    const templates = getBuiltinTemplates();
    for (const t of templates) {
      expect(t.body.length).toBeGreaterThan(0);
    }
  });

  it("each template variable has name, label, and type", () => {
    const templates = getBuiltinTemplates();
    for (const t of templates) {
      for (const v of t.meta.variables) {
        expect(v.name).toBeTruthy();
        expect(v.label).toBeTruthy();
        expect(["string", "number", "boolean"]).toContain(v.type);
      }
    }
  });

  it("all templates render successfully with default values", () => {
    const templates = getBuiltinTemplates();
    for (const t of templates) {
      // Render with empty values (should use defaults)
      const rendered = renderTemplate(t, {});
      expect(rendered.length).toBeGreaterThan(0);
      // Should not contain any unresolved {{variable}} placeholders
      expect(rendered).not.toMatch(/\{\{[a-z_]+\}\}/);
    }
  });

  it("template names are unique", () => {
    const templates = getBuiltinTemplates();
    const names = templates.map((t) => t.meta.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
