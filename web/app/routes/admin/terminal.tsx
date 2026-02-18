import type { Route } from "./+types/terminal";
import { requireAdmin } from "~/lib/auth/middleware";
import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { PageHeader } from "~/components/PageHeader";

export function meta() {
  return [{ title: "Terminal — Nginx Manager" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  return {};
}

export default function TerminalPage({ loaderData }: Route.ComponentProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!termRef.current) return;

    let cleanup: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      // Dynamic imports for SSR safety
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      await import("@xterm/xterm/css/xterm.css");

      if (cancelled || !termRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        theme: {
          background: "#1a1a2e",
          foreground: "#f8f8f2",
          cursor: "#f8f8f2",
          cursorAccent: "#1a1a2e",
          selectionBackground: "#44475a",
          black: "#21222c",
          red: "#ff5555",
          green: "#50fa7b",
          yellow: "#f1fa8c",
          blue: "#6272a4",
          magenta: "#ff79c6",
          cyan: "#8be9fd",
          white: "#f8f8f2",
          brightBlack: "#6272a4",
          brightRed: "#ff6e6e",
          brightGreen: "#69ff94",
          brightYellow: "#ffffa5",
          brightBlue: "#d6acff",
          brightMagenta: "#ff92df",
          brightCyan: "#a4ffff",
          brightWhite: "#ffffff",
        },
        scrollback: 5000,
        convertEol: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(termRef.current);
      fitAddon.fit();

      // Get a short-lived JWT token for WebSocket authentication
      let token: string;
      try {
        const tokenRes = await fetch("/api/terminal-token");
        if (!tokenRes.ok) {
          const data = await tokenRes.json().catch(() => ({}));
          setError(data.error || "Failed to get terminal token. Ensure you have admin access.");
          term.dispose();
          return;
        }
        const data = await tokenRes.json();
        token = data.token;
      } catch {
        setError("Failed to request terminal token.");
        term.dispose();
        return;
      }

      if (cancelled) {
        term.dispose();
        return;
      }

      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsProtocol}//${window.location.host}/terminal?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (cancelled) {
          ws.close();
          return;
        }
        setConnected(true);
        term.focus();
        // Send initial terminal size
        ws.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
        );
      };

      ws.onmessage = (event) => {
        term.write(event.data);
      };

      ws.onerror = () => {
        setError(
          "WebSocket connection failed. The terminal server may not be running."
        );
      };

      ws.onclose = (event) => {
        setConnected(false);
        if (event.code === 1008) {
          setError(`Connection rejected: ${event.reason || "Unauthorized"}`);
        }
        term.write("\r\n\x1b[31m[Connection closed]\x1b[0m\r\n");
      };

      // Forward terminal input to WebSocket
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      // Handle container resize
      const observer = new ResizeObserver(() => {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            })
          );
        }
      });
      observer.observe(termRef.current);

      cleanup = () => {
        observer.disconnect();
        ws.close();
        term.dispose();
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Terminal"
        description="System shell access"
        actions={
          <Badge variant={connected ? "default" : "secondary"}>
            {connected ? "Connected" : "Disconnected"}
          </Badge>
        }
      />

      {error && (
        <div className="bg-destructive/10 text-destructive border border-destructive/20 p-3 rounded-md text-sm">
          {error}
        </div>
      )}

      <Card glass>
        <CardContent className="p-0 overflow-hidden rounded-lg">
          <div
            ref={termRef}
            className="h-[calc(100vh-200px)] min-h-[400px]"
          />
        </CardContent>
      </Card>
    </div>
  );
}
