import { useState, useEffect } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Copy, RefreshCw, ShieldOff } from "lucide-react";

export function McpEndpointCard() {
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/tokens")
      .then((r) => r.json())
      .then((d) => setSecret(d.mcpPathSecret ?? null))
      .catch(() => undefined);
  }, []);

  async function setEnabled(enabled: boolean) {
    setBusy(true);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_mcp_secret", enabled }),
      });
      if (!res.ok) {
        toast.error("Failed to update secret path");
        return;
      }
      const data = await res.json();
      setSecret(data.mcpPathSecret ?? null);
      toast.success(
        enabled
          ? "Secret path regenerated — old URL is invalid immediately"
          : "Secret path disabled — endpoint is back at /api/mcp"
      );
    } finally {
      setBusy(false);
    }
  }

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const url = `${origin}/api/mcp${secret ? `/${secret}` : ""}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP Endpoint</CardTitle>
        <CardDescription>
          Optional secret path segment on top of token auth. When enabled, the bare
          /api/mcp URL returns 404 — useful against scanners on internet-facing
          instances. Never a replacement for tokens.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <code className="text-xs break-all flex-1">{url}</code>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(url);
                toast.success("Copied");
              } catch {
                toast.error("Copy failed — select and copy manually");
              }
            }}
          >
            <Copy className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => setEnabled(true)}>
            <RefreshCw className="h-4 w-4 mr-1" />
            {secret ? "Regenerate secret path" : "Enable secret path"}
          </Button>
          {secret && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setEnabled(false)}
            >
              <ShieldOff className="h-4 w-4 mr-1" /> Disable
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
