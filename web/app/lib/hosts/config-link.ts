import { basename } from "path";

/**
 * Two-way link between a host and the files the generator writes for it:
 * `host-<id>.conf` (HTTP server block) and `host-<id>-stream.conf` (stream).
 * The names are fixed by `generator.ts`; matching on the basename keeps this
 * independent of where the conf dirs live on a given install.
 */
const HOST_FILE = /^host-(\d+)(-stream)?\.conf$/;

export function hostIdFromConfigPath(filePath: string): number | null {
  const m = HOST_FILE.exec(basename(filePath));
  return m ? Number(m[1]) : null;
}

export function hostConfigFileNames(id: number): string[] {
  return [`host-${id}.conf`, `host-${id}-stream.conf`];
}
