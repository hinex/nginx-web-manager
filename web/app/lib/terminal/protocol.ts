/**
 * Client -> server messages on the terminal WebSocket.
 *
 * Anything that is not a recognised control message is keystrokes for the
 * shell. Control messages are JSON objects with a `type` field.
 */
export type TerminalMessage =
  | { kind: "resize"; cols: number; rows: number }
  | { kind: "ping" }
  | { kind: "input"; data: string };

/**
 * How often the browser sends a heartbeat. Bun pings an idle socket only
 * about every 96s, while a reverse proxy in front of the panel commonly
 * drops an idle WebSocket sooner (nginx proxy_read_timeout defaults to 60s,
 * Cloudflare to 100s) - so a quiet terminal was cut off. 25s stays under both.
 */
export const HEARTBEAT_INTERVAL_MS = 25_000;

export const PING_MESSAGE = JSON.stringify({ type: "ping" });

export function parseTerminalMessage(msg: string): TerminalMessage {
  if (msg.startsWith("{")) {
    try {
      const parsed = JSON.parse(msg);
      if (parsed && typeof parsed === "object") {
        if (
          parsed.type === "resize" &&
          typeof parsed.cols === "number" &&
          typeof parsed.rows === "number"
        ) {
          return {
            kind: "resize",
            cols: Math.max(1, parsed.cols),
            rows: Math.max(1, parsed.rows),
          };
        }
        if (parsed.type === "ping") return { kind: "ping" };
      }
    } catch {
      // Not JSON - keystrokes that happen to start with "{"
    }
  }
  return { kind: "input", data: msg };
}
