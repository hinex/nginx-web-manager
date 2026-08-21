import { describe, it, expect } from "vitest";
import { syntaxError } from "./syntax";

describe("syntaxError", () => {
  it("returns null for a balanced config", () => {
    const content = `
server {
    listen 80;
    server_name example.com;
    location /api {
        proxy_pass http://10.0.0.1:8080;
    }
}
`;
    expect(syntaxError(content)).toBeNull();
  });

  it("detects an unclosed '{' and reports the line it was opened on", () => {
    const content = `server { listen 80;`;
    expect(syntaxError(content)).toEqual({ line: 1, message: "Unclosed '{'" });
  });

  it("detects a stray '}' and reports its line", () => {
    const content = `server {
    listen 80;
    server_name example.com;
}
}
`;
    // The stray '}' is on line 5.
    expect(syntaxError(content)).toEqual({ line: 5, message: "Unexpected '}'" });
  });

  it("does not treat a '}' inside a quoted string as a structural brace", () => {
    const content = `
server {
    location /x {
        return 200 "}";
    }
}
`;
    expect(syntaxError(content)).toBeNull();
  });

  it("does not treat '{' inside a '#' comment as a structural brace", () => {
    const content = `
# a note about { braces }
server {
    listen 80;
}
`;
    expect(syntaxError(content)).toBeNull();
  });

  it("detects a second top-level server block and reports its line", () => {
    const content = `server {
    listen 80;
}
server {
    listen 81;
}
`;
    expect(syntaxError(content)).toEqual({
      line: 4,
      message: "A second server block cannot be represented in the host model",
    });
  });

  it("does not flag a nested block merely named like a directive value", () => {
    const content = `
upstream backend {
    server 10.0.0.5:9000;
}
server {
    listen 80;
}
`;
    expect(syntaxError(content)).toBeNull();
  });
});
