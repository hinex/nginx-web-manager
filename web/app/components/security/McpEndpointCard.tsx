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
import { Switch } from "~/components/ui/switch";
import { Label } from "~/components/ui/label";
import { Copy, RefreshCw, ShieldOff } from "lucide-react";

export function McpEndpointCard() {
  const [secret, setSecret] = useState<string | null>(null);
  const [requireMtls, setRequireMtls] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mtlsBusy, setMtlsBusy] = useState(false);

  useEffect(() => {
    fetch("/api/tokens")
      .then((r) => r.json())
      .then((d) => {
        setSecret(d.mcpPathSecret ?? null);
        setRequireMtls(d.requireMtls ?? false);
      })
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

  async function toggleMtls(enabled: boolean) {
    setMtlsBusy(true);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_require_mtls", enabled }),
      });
      if (!res.ok) {
        toast.error("Failed to update mTLS setting");
        return;
      }
      const data = await res.json();
      setRequireMtls(data.requireMtls ?? false);
      toast.success(
        enabled
          ? "mTLS required — only requests with X-Client-Verify: SUCCESS pass"
          : "mTLS disabled"
      );
    } finally {
      setMtlsBusy(false);
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
      <CardContent className="space-y-4">
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

        <div className="border-t pt-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="require-mtls" className="text-sm font-medium">
                Require mTLS (X-Client-Verify)
              </Label>
              <p className="text-xs text-muted-foreground">
                When enabled, every API and MCP request must carry{" "}
                <code className="rounded bg-muted px-1">X-Client-Verify: SUCCESS</code>{" "}
                — only effective when nginx is configured to set and overwrite this
                header (see <a href="/docs/mtls.md" className="underline">docs/mtls.md</a>).
                Enabling this without the correct proxy configuration will lock out all
                API clients.
              </p>
            </div>
            <Switch
              id="require-mtls"
              checked={requireMtls}
              disabled={mtlsBusy}
              onCheckedChange={toggleMtls}
              aria-label="Require mTLS"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
