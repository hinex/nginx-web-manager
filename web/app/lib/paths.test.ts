import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Nine modules resolved the nginx directory independently and only one of them
 * — the generator — honoured `DATA_NGINX_DIR`. A deployment that set only the
 * deprecated alias (which older docs told people to do) wrote host files into
 * `$DATA_NGINX_DIR/conf.d` while the config editor, export, import and cluster
 * sync all read `/data/nginx/conf.d`: a server that is running fine, and an
 * editor showing an empty or stale tree.
 *
 * The capture happens at module scope, so the environment must be set before
 * the import — hence `vi.resetModules()` and dynamic `import()` inside the test.
 */

const ORIGINAL = { ...process.env };

// configs.ts pulls in the db connection at module scope; keep it off disk.
process.env.DB_PATH = ":memory:";

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe("nginx directory resolution", () => {
  it("agrees between the generator and the config editor when only DATA_NGINX_DIR is set", async () => {
    vi.resetModules();
    process.env.DB_PATH = ":memory:";
    delete process.env.NGINX_DIR;
    process.env.DATA_NGINX_DIR = "/custom/nginx";

    const { HOST_CONF_DIR } = await import("~/lib/nginx/generator");
    const { nginxDir } = await import("~/lib/services/configs");

    expect(HOST_CONF_DIR.startsWith(nginxDir())).toBe(true);
  });

  it("prefers NGINX_DIR over the deprecated alias", async () => {
    vi.resetModules();
    process.env.DB_PATH = ":memory:";
    process.env.NGINX_DIR = "/primary/nginx";
    process.env.DATA_NGINX_DIR = "/legacy/nginx";

    const { nginxDir } = await import("~/lib/services/configs");
    expect(nginxDir()).toBe("/primary/nginx");
  });

  it("falls back to /data/nginx when neither is set", async () => {
    vi.resetModules();
    process.env.DB_PATH = ":memory:";
    delete process.env.NGINX_DIR;
    delete process.env.DATA_NGINX_DIR;

    const { nginxDir } = await import("~/lib/services/configs");
    expect(nginxDir()).toBe("/data/nginx");
  });
});
