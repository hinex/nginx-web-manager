export interface Token {
  type: "word" | "block_start" | "block_end" | "semicolon" | "comment";
  value: string;
  line: number;
  col: number;
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  while (i < input.length) {
    const ch = input[i];

    // Newline
    if (ch === "\n") {
      line++;
      col = 1;
      i++;
      continue;
    }

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\r") {
      col++;
      i++;
      continue;
    }

    // Comment
    if (ch === "#") {
      const start = i;
      const startCol = col;
      while (i < input.length && input[i] !== "\n") {
        i++;
        col++;
      }
      tokens.push({ type: "comment", value: input.slice(start, i), line, col: startCol });
      continue;
    }

    // Block start
    if (ch === "{") {
      tokens.push({ type: "block_start", value: "{", line, col });
      i++;
      col++;
      continue;
    }

    // Block end
    if (ch === "}") {
      tokens.push({ type: "block_end", value: "}", line, col });
      i++;
      col++;
      continue;
    }

    // Semicolon
    if (ch === ";") {
      tokens.push({ type: "semicolon", value: ";", line, col });
      i++;
      col++;
      continue;
    }

    // Quoted string (single or double)
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      const startLine = line;
      const startCol = col;
      i++;
      col++;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\") {
          i++; col++;
          if (i >= input.length) break;
        } else if (input[i] === "\n") {
          line++;
          col = 0;
        }
        i++;
        col++;
      }
      if (i < input.length) {
        i++; // closing quote
        col++;
      }
      tokens.push({ type: "word", value: input.slice(start, i), line: startLine, col: startCol });
      continue;
    }

    // Word (unquoted)
    const start = i;
    const startCol = col;
    while (
      i < input.length &&
      input[i] !== " " &&
      input[i] !== "\t" &&
      input[i] !== "\n" &&
      input[i] !== "\r" &&
      input[i] !== ";" &&
      input[i] !== "{" &&
      input[i] !== "}" &&
      input[i] !== "#"
    ) {
      i++;
      col++;
    }
    if (i > start) {
      tokens.push({ type: "word", value: input.slice(start, i), line, col: startCol });
    }
  }

  return tokens;
}
