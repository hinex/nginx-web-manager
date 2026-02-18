import { tokenize } from "./tokenizer";

export interface NgxDirective {
  name: string;
  args: string[];
  block?: NgxBlock;
  comments?: string[];
  line: number;
}

export interface NgxBlock {
  directives: NgxDirective[];
}

export interface NgxConfig {
  directives: NgxDirective[];
  filePath?: string;
}

export function parse(input: string, filePath?: string): NgxConfig {
  const tokens = tokenize(input);
  let pos = 0;
  const pendingComments: string[] = [];

  function parseDirectives(): NgxDirective[] {
    const directives: NgxDirective[] = [];

    while (pos < tokens.length) {
      const token = tokens[pos];

      if (token.type === "block_end") {
        break;
      }

      if (token.type === "comment") {
        pendingComments.push(token.value);
        pos++;
        continue;
      }

      if (token.type === "word") {
        const directive = parseDirective();
        if (directive) {
          directives.push(directive);
        }
        continue;
      }

      pos++;
    }

    return directives;
  }

  function parseDirective(): NgxDirective | null {
    const nameToken = tokens[pos];
    if (!nameToken || nameToken.type !== "word") return null;

    const name = nameToken.value;
    const line = nameToken.line;
    const comments = pendingComments.length > 0 ? [...pendingComments] : undefined;
    pendingComments.length = 0;

    pos++;
    const args: string[] = [];

    while (pos < tokens.length) {
      const token = tokens[pos];

      if (token.type === "semicolon") {
        pos++;
        return { name, args, line, ...(comments ? { comments } : {}) };
      }

      if (token.type === "block_start") {
        pos++;
        const directives = parseDirectives();
        if (pos < tokens.length && tokens[pos].type === "block_end") {
          pos++;
        }
        return { name, args, block: { directives }, line, ...(comments ? { comments } : {}) };
      }

      if (token.type === "word") {
        args.push(token.value);
        pos++;
        continue;
      }

      if (token.type === "comment") {
        pendingComments.push(token.value);
        pos++;
        continue;
      }

      pos++;
    }

    // Directive without semicolon or block (end of input)
    if (args.length > 0 || name) {
      return { name, args, line, ...(comments ? { comments } : {}) };
    }
    return null;
  }

  return {
    directives: parseDirectives(),
    filePath,
  };
}
