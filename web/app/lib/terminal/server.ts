import { verifyToken } from "~/lib/auth/jwt.server";

interface TerminalSession {
  proc: ReturnType<typeof Bun.spawn>;
  ws: object;
}

const terminals = new Map<object, TerminalSession>();

export function startTerminalServer(port = 3001) {
  Bun.serve<{ token: string }>({
    port,
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/terminal") {
        const token = url.searchParams.get("token");
        if (!token) {
          return new Response("Unauthorized", { status: 401 });
        }

        const success = server.upgrade(req, { data: { token } });
        if (success) return undefined;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      async open(ws) {
        const token = ws.data?.token;
        if (!token) {
          ws.close(1008, "No token provided");
          return;
        }

        const payload = await verifyToken(token);
        if (!payload || payload.role !== "admin") {
          ws.close(1008, "Unauthorized — admin role required");
          return;
        }

        try {
          const proc = Bun.spawn(["/bin/bash"], {
            cwd: process.env.HOME || "/",
            env: {
              ...process.env,
              TERM: "xterm-256color",
              SHELL: "/bin/bash",
            },
            terminal: {
              cols: 80,
              rows: 24,
              data(_terminal, data) {
                try {
                  // Convert to string so xterm.js receives text frames
                  const str = typeof data === "string"
                    ? data
                    : new TextDecoder().decode(data);
                  ws.sendText(str);
                } catch {
                  // WebSocket may have closed
                }
              },
              exit() {
                try {
                  ws.close(1000, "Shell exited");
                } catch {
                  // WebSocket may already be closed
                }
                terminals.delete(ws);
              },
            },
          });

          terminals.set(ws, { proc, ws });
          console.log("[terminal] Shell spawned, pid:", proc.pid);
        } catch (err) {
          console.error("[terminal] Failed to spawn shell:", err);
          ws.close(1011, "Failed to spawn shell");
        }
      },

      message(ws, message) {
        const session = terminals.get(ws);
        if (!session) return;

        const msg =
          typeof message === "string"
            ? message
            : new TextDecoder().decode(message as unknown as ArrayBuffer);

        // Handle resize messages (JSON with type: "resize")
        try {
          const parsed = JSON.parse(msg);
          if (
            parsed.type === "resize" &&
            typeof parsed.cols === "number" &&
            typeof parsed.rows === "number"
          ) {
            session.proc.terminal?.resize(
              Math.max(1, parsed.cols),
              Math.max(1, parsed.rows)
            );
            return;
          }
        } catch {
          // Not JSON — treat as stdin data
        }

        session.proc.terminal?.write(msg);
      },

      close(ws) {
        const session = terminals.get(ws);
        if (session) {
          try {
            session.proc.kill();
          } catch {
            // Process may already be dead
          }
          terminals.delete(ws);
        }
      },
    },
  });

  console.log(`[terminal] WebSocket server running on port ${port}`);
}
