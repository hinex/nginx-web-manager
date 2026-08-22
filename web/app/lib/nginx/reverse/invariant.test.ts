import { describe, it, expect } from "vitest";
import { parse } from "~/lib/nginx/parser";
import { diffAst } from "./match";
import { classifyDelta, classifyStreamDelta, type StreamHostConfig } from "./classify";
import { buildServerBlock, type HostConfig } from "~/lib/nginx/templates/server-block";
import { buildStreamBlock } from "~/lib/nginx/templates/stream";

/**
 * The invariant: a changed file yields at least one edit or at least one
 * refusal — never nothing.
 *
 * Three defects in this subsystem shared one signature: the text changed, the
 * delta came back empty, and the save reported success (§42/§44 sibling
 * collapse, §45 compression fragment, §49 fabricated header edit). Case-by-case
 * tests only cover the cases already found. This walks every directive line the
 * generator emits, deletes it and mutates it, and asserts the classifier said
 * *something* about it.
 *
 * A failure here is one of three things, in descending order of likelihood:
 *   1. silent loss     - representable edit produced nothing -> fix the classifier
 *   2. missing refusal - unrepresentable edit raised no refusal -> add the refusal
 *   3. harness artefact - the mutation targets a line the model does not own
 * Never weaken the assertion. Excluding a line is a claim that it cannot carry
 * user intent; see EXCLUDED below, every entry is justified.
 */

const baseLocation: HostConfig["locations"][number] = {
  path: "/api",
  matchType: "prefix",
  type: "proxy",
  upstreams: [{ server: "10.0.0.1", port: 8080, weight: 1 }],
  balanceMethod: "round_robin",
  staticDir: "",
  cacheExpires: "",
  forwardScheme: "https",
  forwardDomain: "",
  forwardPath: "/",
  preservePath: false,
  statusCode: 301,
  headers: { "X-Real-IP": "$remote_addr" },
  accessListId: null,
  basicAuth: null,
};

const baseHost: HostConfig = {
  id: 7,
  groupId: null,
  domains: ["example.com"],
  enabled: true,
  sslType: "none",
  sslForceHttps: false,
  sslCertPath: null,
  sslKeyPath: null,
  hsts: false,
  http2: false,
  compression: false,
  redirectWww: false,
  clientMaxBodySize: "1m",
  locations: [baseLocation],
  advancedNginx: null,
  webhookUrl: null,
  errorPagesDir: null,
  basicAuth: null,
  dnsResolver: null,
  dnsResolverValid: null,
};

const MATRIX: Array<[string, HostConfig]> = [
  ["plain", baseHost],
  [
    "ssl+hsts+http2",
    {
      ...baseHost,
      sslType: "custom",
      sslCertPath: "/c.pem",
      sslKeyPath: "/k.pem",
      sslForceHttps: true,
      hsts: true,
      http2: true,
    },
  ],
  ["compression", { ...baseHost, compression: true }],
  ["redirectWww", { ...baseHost, domains: ["www.example.com", "example.com"], redirectWww: true }],
  ["two locations", { ...baseHost, locations: [baseLocation, { ...baseLocation, path: "/second" }] }],
  [
    "static + redirect locations",
    {
      ...baseHost,
      locations: [
        { ...baseLocation, path: "/files", type: "static", staticDir: "/srv/files", cacheExpires: "30d" },
        { ...baseLocation, path: "/old", type: "redirect", forwardDomain: "new.example.com" },
      ],
    },
  ],
];

/**
 * Lines the model provably does not own, so a hand edit to them carries no
 * intent the host form could express: the ACME challenge location is injected
 * verbatim into every host and is derived from no field at all.
 */
const EXCLUDED = /acme-challenge/;

/** Comments, blanks and pure block punctuation carry no directive. */
function isDirectiveLine(l: string): boolean {
  const t = l.trim();
  if (t.length === 0) return false;
  if (t.startsWith("#")) return false;
  if (t === "}" || t.endsWith("{")) return false;
  if (EXCLUDED.test(t)) return false;
  return true;
}

function targetsOf(rendered: string): Array<[string, number]> {
  return rendered
    .split("\n")
    .map((l, i) => [l, i] as [string, number])
    .filter(([l]) => isDirectiveLine(l));
}

describe.each(MATRIX)("save is never silent: %s", (_name, host) => {
  const rendered = buildServerBlock(host, new Map());
  const lines = rendered.split("\n");
  const targets = targetsOf(rendered);

  it("renders at least one directive to probe", () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  it.each(targets)("deleting `%s` is reported", (_line, idx) => {
    const edited = lines.filter((_, i) => i !== idx).join("\n");
    const c = classifyDelta(diffAst(parse(rendered), parse(edited)), host);
    expect(c.edits.length + c.refusals.length).toBeGreaterThan(0);
  });

  it.each(targets)("mutating `%s` is reported", (line, idx) => {
    const next = [...lines];
    next[idx] = line.replace(/;\s*$/, " zzz_probe;");
    expect(next[idx]).not.toBe(line);
    const c = classifyDelta(diffAst(parse(rendered), parse(next.join("\n"))), host);
    expect(c.edits.length + c.refusals.length).toBeGreaterThan(0);
  });

  it.each(targets)("deleting `%s` fabricates nothing", (line, idx) => {
    const edited = lines.filter((_, i) => i !== idx).join("\n");
    const c = classifyDelta(diffAst(parse(rendered), parse(edited)), host);
    for (const e of c.edits) {
      if (e.kind !== "location-advanced" && e.kind !== "server-advanced") continue;
      // Raw text may only echo the line that actually changed.
      expect(line).toContain(e.text.split(" ")[0]);
    }
  });
});

const streamHost: StreamHostConfig = {
  id: 7,
  streamPorts: [
    {
      port: 5432,
      protocol: "tcp",
      upstreams: [{ server: "10.0.0.1", port: 5432, weight: 1 }],
      balanceMethod: "round_robin",
    },
    {
      port: 5353,
      protocol: "udp",
      upstreams: [{ server: "10.0.0.2", port: 53, weight: 1 }],
      balanceMethod: "least_conn",
    },
  ],
};

describe("save is never silent: stream", () => {
  const rendered = buildStreamBlock(streamHost.id, streamHost.streamPorts as never, null, null);
  const lines = rendered.split("\n");
  const targets = targetsOf(rendered);

  it("renders at least one directive to probe", () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  it.each(targets)("deleting `%s` is reported", (_line, idx) => {
    const edited = lines.filter((_, i) => i !== idx).join("\n");
    const c = classifyStreamDelta(diffAst(parse(rendered), parse(edited)), streamHost);
    expect(c.edits.length + c.refusals.length).toBeGreaterThan(0);
  });

  it.each(targets)("mutating `%s` is reported", (line, idx) => {
    const next = [...lines];
    next[idx] = line.replace(/;\s*$/, " zzz_probe;");
    expect(next[idx]).not.toBe(line);
    const c = classifyStreamDelta(diffAst(parse(rendered), parse(next.join("\n"))), streamHost);
    expect(c.edits.length + c.refusals.length).toBeGreaterThan(0);
  });
});
