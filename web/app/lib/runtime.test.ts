import { describe, it, expect } from "vitest";

// This app runs on Bun: the DB driver is `bun:sqlite`, and `update-semantics.test.ts`
// exists specifically to pin that driver's behaviour. Under Node those files do not
// merely fail — they fail to load, with "Only URLs with a scheme in: file, data, and
// node are supported by the default ESM loader. Received protocol 'bun:'", which names
// neither the file that asked nor the runtime that is wrong.
//
// The v1.2.0 release CI ran `bun run test`. `bun run` honours the shebang of the binary
// it invokes, and `node_modules/.bin/vitest` starts with `#!/usr/bin/env node` — so the
// suite ran on Node, three files never loaded, and the release published no image.
// `bun run --bun test` keeps the suite on Bun.
//
// A machine where `node` is Bun's own wrapper (a plain `bun install`-based dev box) runs
// the whole suite green either way, so this cannot be left to local runs to catch.
describe("the runtime the suite runs on", () => {
  it("is Bun, because the app's SQLite driver exists nowhere else", () => {
    const underBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
    expect(
      underBun,
      "This suite must run on Bun — use `bun run --bun test`. Running it on Node leaves " +
        "every `bun:sqlite` importer unloadable and silently drops those tests.",
    ).toBe(true);
  });
});
