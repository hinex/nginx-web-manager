import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname, basename, isAbsolute } from "path";
import { parse, type NgxConfig } from "./ast";
import { render } from "./renderer";

export type { NgxConfig, NgxDirective, NgxBlock } from "./ast";
export type { Token } from "./tokenizer";
export { tokenize } from "./tokenizer";
export { parse } from "./ast";
export { render } from "./renderer";

export interface NgxConfigWithIncludes extends NgxConfig {
  includes?: NgxConfig[];
}

/**
 * Parse a config file from disk into AST.
 */
export function parseFile(filePath: string): NgxConfigWithIncludes {
  const content = readFileSync(filePath, "utf-8");
  return { ...parse(content, filePath), includes: [] };
}

/**
 * List all .conf files recursively under a directory.
 */
export function listConfigFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(d: string) {
    const entries = readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".conf")) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results.sort();
}

/**
 * Resolve include directives in a parsed config by reading referenced files.
 */
export function resolveIncludes(
  config: NgxConfigWithIncludes
): NgxConfigWithIncludes {
  const includes: NgxConfig[] = [];

  function findIncludes(directives: NgxConfig["directives"]) {
    for (const directive of directives) {
      if (directive.name === "include") {
        const pattern = directive.args[0];
        if (pattern) {
          const resolved = resolveGlob(
            pattern,
            config.filePath ? dirname(config.filePath) : undefined
          );
          for (const filePath of resolved) {
            try {
              const included = parseFile(filePath);
              includes.push(included);
            } catch {
              // Skip unreadable files
            }
          }
        }
      }
      if (directive.block) {
        findIncludes(directive.block.directives);
      }
    }
  }

  findIncludes(config.directives);
  return { ...config, includes };
}

/**
 * Convert a simple glob pattern (supporting only trailing `*` wildcards)
 * into a regular expression. Handles patterns like `*.conf` or `*.conf`.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\*/g, ".*");
  return new RegExp("^" + withWildcards + "$");
}

/**
 * Resolve a glob pattern to actual file paths.
 * Supports single-level wildcards (e.g., *.conf, site-*.conf).
 * Does NOT support recursive globs (**).
 */
function resolveGlob(pattern: string, baseDir?: string): string[] {
  try {
    // Resolve relative patterns against baseDir
    const resolvedPattern = isAbsolute(pattern)
      ? pattern
      : join(baseDir ?? process.cwd(), pattern);

    if (resolvedPattern.includes("*")) {
      const dir = dirname(resolvedPattern);
      const filePattern = basename(resolvedPattern);
      const regex = globToRegex(filePattern);
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        return entries
          .filter((e) => e.isFile() && regex.test(e.name))
          .map((e) => join(dir, e.name))
          .sort();
      } catch {
        return [];
      }
    }
    return [resolvedPattern];
  } catch {
    return [];
  }
}

/**
 * Write an AST config back to disk.
 */
export function writeConfig(config: NgxConfig, filePath?: string): void {
  const outPath = filePath || config.filePath;
  if (!outPath) throw new Error("No file path specified");
  writeFileSync(outPath, render(config));
}
