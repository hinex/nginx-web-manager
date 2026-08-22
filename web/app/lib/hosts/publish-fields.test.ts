import { describe, it, expect } from "vitest";
import { nullableHostFields, clientMaxBodySizeOf } from "./publish-fields";

describe("nullableHostFields", () => {
  it("maps a cleared field to null, not undefined", () => {
    const out = nullableHostFields({
      sslCertPath: "",
      sslKeyPath: "",
      webhookUrl: "",
      advancedNginx: "",
      customPrelude: "",
    });
    for (const [k, v] of Object.entries(out)) {
      expect(v, `${k} must be null so drizzle writes it`).toBeNull();
    }
  });

  it("keeps a set field verbatim, including significant whitespace inside", () => {
    const prelude = "map $http_upgrade $connection_upgrade {\n  default upgrade;\n  '' close;\n}";
    expect(nullableHostFields({ customPrelude: prelude } as never).customPrelude).toBe(prelude);
  });

  it("treats a whitespace-only field as cleared", () => {
    expect(nullableHostFields({ advancedNginx: "  \n  " } as never).advancedNginx).toBeNull();
  });

  it("treats an absent field as cleared", () => {
    expect(nullableHostFields({} as never).sslCertPath).toBeNull();
  });

  // The sixth affected field, clientMaxBodySize, is not nullable — see below.
  it("reports every one of the five nullable fields", () => {
    expect(Object.keys(nullableHostFields({} as never)).sort()).toEqual([
      "advancedNginx",
      "customPrelude",
      "sslCertPath",
      "sslKeyPath",
      "webhookUrl",
    ]);
  });
});

describe("clientMaxBodySizeOf", () => {
  it("falls back to the column default rather than null", () => {
    expect(clientMaxBodySizeOf("")).toBe("1m");
    expect(clientMaxBodySizeOf(undefined)).toBe("1m");
    expect(clientMaxBodySizeOf("   ")).toBe("1m");
  });

  it("keeps a set size", () => {
    expect(clientMaxBodySizeOf("25m")).toBe("25m");
    expect(clientMaxBodySizeOf(" 25m ")).toBe("25m");
  });
});
