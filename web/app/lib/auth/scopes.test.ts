import { describe, it, expect } from "vitest";
import {
  ALL_SCOPES,
  SCOPE_DESCRIPTIONS,
  ROLE_CEILINGS,
  intersectScopes,
  isScope,
} from "./scopes";

describe("scopes", () => {
  it("defines exactly the nine spec scopes in order", () => {
    expect(ALL_SCOPES).toEqual([
      "configs:read",
      "configs:write",
      "configs:publish",
      "nginx:validate",
      "nginx:reload",
      "hosts:read",
      "hosts:write",
      "hosts:publish",
      "stats:read",
    ]);
  });

  it("every scope has a human description", () => {
    for (const s of ALL_SCOPES) {
      expect(SCOPE_DESCRIPTIONS[s]).toBeTruthy();
    }
  });

  it("viewer ceiling is read-only + validate", () => {
    expect(ROLE_CEILINGS.viewer).toEqual([
      "configs:read",
      "hosts:read",
      "stats:read",
      "nginx:validate",
    ]);
  });

  it("editor ceiling adds write, publish, reload, hosts:write, hosts:publish", () => {
    expect(ROLE_CEILINGS.editor).toEqual([
      "configs:read",
      "hosts:read",
      "stats:read",
      "nginx:validate",
      "configs:write",
      "configs:publish",
      "nginx:reload",
      "hosts:write",
      "hosts:publish",
    ]);
  });

  it("admin ceiling is all scopes", () => {
    expect(ROLE_CEILINGS.admin).toEqual(ALL_SCOPES);
  });

  it("intersectScopes drops scopes above the ceiling", () => {
    expect(intersectScopes(["configs:read", "configs:write"], "viewer")).toEqual([
      "configs:read",
    ]);
  });

  it("intersectScopes returns empty for unknown role", () => {
    expect(intersectScopes(["configs:read"], "nobody")).toEqual([]);
  });

  it("intersectScopes ignores unknown scope strings", () => {
    expect(intersectScopes(["configs:read", "lol:hack"], "admin")).toEqual([
      "configs:read",
    ]);
  });

  it("isScope narrows correctly", () => {
    expect(isScope("configs:read")).toBe(true);
    expect(isScope("root:everything")).toBe(false);
  });

  it("isScope recognises hosts:write and hosts:publish", () => {
    expect(isScope("hosts:write")).toBe(true);
    expect(isScope("hosts:publish")).toBe(true);
  });

  it("intersectScopes: viewer excludes hosts:write and hosts:publish", () => {
    expect(
      intersectScopes(["hosts:read", "hosts:write", "hosts:publish"], "viewer"),
    ).toEqual(["hosts:read"]);
  });

  it("intersectScopes: editor includes hosts:write and hosts:publish", () => {
    expect(
      intersectScopes(["hosts:write", "hosts:publish"], "editor"),
    ).toEqual(["hosts:write", "hosts:publish"]);
  });
});
