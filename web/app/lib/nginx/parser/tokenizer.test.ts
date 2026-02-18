import { describe, it, expect } from "vitest";
import { tokenize, type Token } from "./tokenizer";

describe("tokenize", () => {
  it("tokenizes a simple directive", () => {
    const tokens = tokenize("worker_processes auto;");
    expect(tokens).toEqual([
      { type: "word", value: "worker_processes", line: 1, col: 1 },
      { type: "word", value: "auto", line: 1, col: 18 },
      { type: "semicolon", value: ";", line: 1, col: 22 },
    ]);
  });

  it("tokenizes a block", () => {
    const tokens = tokenize("events {\n    worker_connections 1024;\n}");
    expect(tokens).toEqual([
      { type: "word", value: "events", line: 1, col: 1 },
      { type: "block_start", value: "{", line: 1, col: 8 },
      { type: "word", value: "worker_connections", line: 2, col: 5 },
      { type: "word", value: "1024", line: 2, col: 24 },
      { type: "semicolon", value: ";", line: 2, col: 28 },
      { type: "block_end", value: "}", line: 3, col: 1 },
    ]);
  });

  it("tokenizes comments", () => {
    const tokens = tokenize("# this is a comment\nworker_processes 1;");
    expect(tokens[0]).toEqual({
      type: "comment",
      value: "# this is a comment",
      line: 1,
      col: 1,
    });
  });

  it("tokenizes quoted strings as single token", () => {
    const tokens = tokenize("log_format main '$remote_addr - $remote_user';");
    const values = tokens.filter(t => t.type === "word").map(t => t.value);
    expect(values).toEqual(["log_format", "main", "'$remote_addr - $remote_user'"]);
  });

  it("tokenizes double-quoted strings", () => {
    const tokens = tokenize('add_header X-Frame-Options "DENY";');
    const values = tokens.filter(t => t.type === "word").map(t => t.value);
    expect(values).toEqual(["add_header", "X-Frame-Options", '"DENY"']);
  });

  it("handles empty input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   \n\n  ")).toEqual([]);
  });

  it("handles nested blocks", () => {
    const input = "http {\n  server {\n    listen 80;\n  }\n}";
    const blockStarts = tokenize(input).filter(t => t.type === "block_start");
    const blockEnds = tokenize(input).filter(t => t.type === "block_end");
    expect(blockStarts.length).toBe(2);
    expect(blockEnds.length).toBe(2);
  });

  it("tokenizes location with regex", () => {
    const tokens = tokenize("location ~ ^/api { proxy_pass http://backend; }");
    const words = tokens.filter(t => t.type === "word").map(t => t.value);
    expect(words).toContain("location");
    expect(words).toContain("~");
    expect(words).toContain("^/api");
  });

  it("reports the opening line for a multi-line quoted string", () => {
    const tokens = tokenize("add_header X-Val 'line1\nline2';");
    const quoted = tokens.find(t => t.value.startsWith("'"));
    expect(quoted?.line).toBe(1);
  });

  it("handles unterminated quoted string without crashing", () => {
    expect(() => tokenize('"unterminated')).not.toThrow();
  });
});
