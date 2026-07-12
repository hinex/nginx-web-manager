import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Badge } from "~/components/ui/badge";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { KeyRound, Copy, Trash2, Plus } from "lucide-react";
import {
  ROLE_CEILINGS,
  SCOPE_DESCRIPTIONS,
  type Role,
  type Scope,
} from "~/lib/auth/scopes";

interface TokenRow {
  id: number;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const EXPIRY_PRESETS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "never", label: "Never" },
];

export function ApiTokensCard({ role }: { role: Role }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [mcpPathSecret, setMcpPathSecret] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [expiry, setExpiry] = useState("30");
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/tokens");
    if (res.ok) {
      const data = await res.json();
      setTokens(data.tokens);
      setMcpPathSecret(data.mcpPathSecret ?? null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const ceiling = ROLE_CEILINGS[role] ?? [];
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const endpoint = `${origin}/api/mcp${mcpPathSecret ? `/${mcpPathSecret}` : ""}`;
  const snippet = createdToken
    ? `claude mcp add nginx-manager --transport http ${endpoint} --header "Authorization: Bearer ${createdToken}"`
    : "";

  function toggleScope(scope: Scope, checked: boolean) {
    setScopes((prev) => (checked ? [...prev, scope] : prev.filter((s) => s !== scope)));
  }

  async function createToken() {
    setCreating(true);
    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name,
          scopes,
          expiresInDays: expiry === "never" ? null : Number(expiry),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to create token");
        return;
      }
      setCreatedToken(data.token);
      setName("");
      setScopes([]);
      toast.success("Token created — copy it now, it will not be shown again");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: TokenRow) {
    const res = await fetch("/api/tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revoke", tokenId: token.id }),
    });
    if (res.ok) {
      toast.success(`Token "${token.name}" revoked`);
      await load();
    } else {
      toast.error("Failed to revoke token");
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Copy failed — select and copy manually");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" /> API Tokens
        </CardTitle>
        <CardDescription>
          Bearer tokens for MCP clients and automation. Scopes are capped by your role
          ({role}). Tokens are shown exactly once at creation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {createdToken && (
          <div className="rounded-md border p-3 space-y-2 bg-muted/50">
            <p className="text-sm font-medium">
              Copy this token now — it will not be shown again:
            </p>
            <div className="flex items-center gap-2">
              <code
                data-testid="created-token"
                className="text-xs break-all flex-1"
              >
                {createdToken}
              </code>
              <Button size="sm" variant="outline" onClick={() => copy(createdToken)}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-sm font-medium">Connect Claude Code:</p>
            <div className="flex items-center gap-2">
              <code className="text-xs break-all flex-1">{snippet}</code>
              <Button size="sm" variant="outline" onClick={() => copy(snippet)}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setCreatedToken(null)}>
              Done
            </Button>
          </div>
        )}

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="token-name">Token name</Label>
            <Input
              id="token-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="claude-code on laptop"
            />
          </div>

          <div className="space-y-2">
            <Label>Scopes</Label>
            {ceiling.map((scope) => (
              <div key={scope} className="flex items-start gap-2">
                <Checkbox
                  id={`scope-${scope}`}
                  checked={scopes.includes(scope)}
                  onCheckedChange={(checked) => toggleScope(scope, checked === true)}
                />
                <div className="grid gap-0.5 leading-none">
                  <Label htmlFor={`scope-${scope}`} className="font-mono text-xs">
                    {scope}
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {SCOPE_DESCRIPTIONS[scope]}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <Label>Expires</Label>
            <div className="flex gap-2">
              {EXPIRY_PRESETS.map((p) => (
                <Button
                  key={p.value}
                  size="sm"
                  variant={expiry === p.value ? "default" : "outline"}
                  onClick={() => setExpiry(p.value)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          <Button
            onClick={createToken}
            disabled={creating || !name.trim() || scopes.length === 0}
          >
            <Plus className="h-4 w-4 mr-1" /> Create Token
          </Button>
        </div>

        {tokens.length > 0 && (
          <div className="space-y-2">
            <Label>Existing tokens</Label>
            {tokens.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-md border p-2 gap-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{t.name}</span>
                    {t.revokedAt && <Badge variant="destructive">revoked</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {t.scopes.join(", ")}
                    {" · "}
                    {t.lastUsedAt
                      ? `last used ${new Date(t.lastUsedAt).toLocaleString()}`
                      : "never used"}
                    {t.expiresAt &&
                      ` · expires ${new Date(t.expiresAt).toLocaleDateString()}`}
                  </div>
                </div>
                {!t.revokedAt && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Revoke ${t.name}`}
                    onClick={() => revoke(t)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
