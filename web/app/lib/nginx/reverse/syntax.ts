export interface SyntaxProblem {
  line: number;
  message: string;
}

/**
 * Standalone scanner for design record §refusal 6.
 *
 * The nginx parser (`~/lib/nginx/parser/ast.ts`) never throws: an unterminated
 * block silently auto-closes and a stray `}` is silently dropped. Neither
 * "syntax the parser cannot handle" nor "a second server block" has any
 * mechanism there, so this scanner provides it independently, without
 * touching the parser's contract.
 */
export function syntaxError(content: string): SyntaxProblem | null {
  let i = 0;
  let line = 1;
  let depth = 0;
  const openLines: number[] = [];
  /** The word immediately before each open brace, parallel to `openLines`. */
  const openWords: string[] = [];
  let topLevelServerBlocks = 0;
  let word = "";
  let lastWord = "";

  const flushWord = () => {
    if (word.length > 0) {
      lastWord = word;
      word = "";
    }
  };

  while (i < content.length) {
    const ch = content[i];

    if (ch === "\n") {
      line++;
      flushWord();
      i++;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r") {
      flushWord();
      i++;
      continue;
    }

    // '#' line comment — everything to end of line is inert.
    if (ch === "#") {
      while (i < content.length && content[i] !== "\n") i++;
      flushWord();
      continue;
    }

    // Quoted string — braces and semicolons inside are inert.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === "\\") {
          i++;
          if (i >= content.length) break;
        } else if (content[i] === "\n") {
          line++;
        }
        i++;
      }
      if (i < content.length) i++; // closing quote
      flushWord();
      continue;
    }

    if (ch === "{") {
      flushWord();
      if (depth === 0 && lastWord === "server") {
        topLevelServerBlocks++;
        if (topLevelServerBlocks === 2) {
          return {
            line,
            message: "A second server block cannot be represented in the host model",
          };
        }
      }
      depth++;
      openLines.push(line);
      openWords.push(lastWord);
      lastWord = "";
      i++;
      continue;
    }

    if (ch === "}") {
      flushWord();
      if (depth === 0) {
        return { line, message: "Unexpected '}'" };
      }
      depth--;
      openLines.pop();
      openWords.pop();
      lastWord = "";
      i++;
      continue;
    }

    if (ch === ";") {
      flushWord();
      lastWord = "";
      i++;
      continue;
    }

    word += ch;
    i++;
  }

  flushWord();

  if (depth > 0) {
    // The *outermost* open brace, deliberately: with `server {` and `location {`
    // both open, the inner one may well be fine and it is the outer block that is
    // genuinely unterminated — that is where the missing `}` belongs. Naming the
    // directive that opened it is the difference between "Unclosed '{'", which
    // points at a character the file is full of, and an actionable message.
    const opener = openWords[0];
    return {
      line: openLines[0],
      message: opener ? `Unclosed '{' opened by '${opener}'` : "Unclosed '{'",
    };
  }

  return null;
}
