import type { Route } from "./+types/settings";
import { Form, useActionData, useNavigation } from "react-router";
import { db } from "~/lib/db/connection";
import { settings } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "~/lib/auth/middleware";
import { generateAllConfigs } from "~/lib/nginx/generator";
import { reloadNginx } from "~/lib/nginx/reload";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { logAudit } from "~/lib/audit/log";
import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Separator } from "~/components/ui/separator";
import { Badge } from "~/components/ui/badge";
import { Loader2, Download, Upload, Lock } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "~/components/PageHeader";

const SETTING_KEYS = [
  "global_webhook_url",
  "watchdog_interval_ms",
  "audit_retention_days",
  "health_retention_days",
  "ip_whitelist",
  "max_login_attempts",
  "login_ban_duration_minutes",
  "config_version_retention_days",
  "dns_resolver",
  "dns_resolver_valid",
] as const;

export function meta() {
  return [{ title: "Settings — Nginx Manager" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const allSettings = db.select().from(settings).all();
  const settingsMap = Object.fromEntries(
    allSettings.map((s) => [s.key, s.value ?? ""])
  );
  return { settings: settingsMap };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUser = await requireAdmin(request);
  const formData = await request.formData();
  const ipAddress = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";

  const changedSettings: Record<string, string> = {};

  for (const key of SETTING_KEYS) {
    const value = (formData.get(key) as string) ?? "";
    const existing = db
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .get();

    if (existing) {
      if (existing.value !== value) {
        changedSettings[key] = value;
      }
      db.update(settings)
        .set({ value })
        .where(eq(settings.key, key))
        .run();
    } else {
      changedSettings[key] = value;
      db.insert(settings).values({ key, value }).run();
    }
  }

  logAudit({
    userId: currentUser.userId,
    action: "update",
    entity: "settings",
    details: changedSettings,
    ipAddress,
  });

  generateAllConfigs();
  const v = validateNginxConfig();
  if (!v.valid) return { error: "Config validation failed: " + v.error };
  reloadNginx();

  return { saved: true };
}

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
  const { settings: currentSettings } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  useEffect(() => {
    if (actionData && "saved" in actionData && actionData.saved) {
      toast.success("Settings saved and config reloaded.");
    }
  }, [actionData]);

  return (
    <div>
      <PageHeader
        title="Settings"
        description="System configuration, backup, and maintenance"
      />

      <Card glass>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <Form method="post" className="space-y-6">
            <div>
              <Label htmlFor="global_webhook_url">Global Webhook URL</Label>
              <Input
                id="global_webhook_url"
                name="global_webhook_url"
                type="url"
                defaultValue={currentSettings.global_webhook_url ?? ""}
                placeholder="https://hooks.example.com/..."
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Called on all config changes if set.
              </p>
            </div>

            <div>
              <Label htmlFor="watchdog_interval_ms">Watchdog Interval (ms)</Label>
              <Input
                id="watchdog_interval_ms"
                name="watchdog_interval_ms"
                type="number"
                min={1000}
                defaultValue={currentSettings.watchdog_interval_ms ?? "30000"}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                How often the watchdog checks upstream health (default: 30000).
              </p>
            </div>

            <div>
              <Label htmlFor="audit_retention_days">Audit Log Retention (days)</Label>
              <Input
                id="audit_retention_days"
                name="audit_retention_days"
                type="number"
                min={1}
                defaultValue={currentSettings.audit_retention_days ?? "90"}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Audit log entries older than this are pruned (default: 90).
              </p>
            </div>

            <div>
              <Label htmlFor="health_retention_days">Health Check Retention (days)</Label>
              <Input
                id="health_retention_days"
                name="health_retention_days"
                type="number"
                min={1}
                defaultValue={currentSettings.health_retention_days ?? "7"}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Health check records older than this are pruned (default: 7).
              </p>
            </div>

            <div>
              <Label htmlFor="ip_whitelist">IP Whitelist</Label>
              <Input
                id="ip_whitelist"
                name="ip_whitelist"
                type="text"
                defaultValue={currentSettings.ip_whitelist ?? ""}
                placeholder="192.168.1.0/24, 10.0.0.1"
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Comma-separated IPs or CIDRs (e.g., 192.168.1.0/24, 10.0.0.1). Leave empty to allow all.
              </p>
            </div>

            <div>
              <Label htmlFor="max_login_attempts">Max Login Attempts</Label>
              <Input
                id="max_login_attempts"
                name="max_login_attempts"
                type="number"
                min={1}
                defaultValue={currentSettings.max_login_attempts ?? "10"}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Maximum failed login attempts before IP is banned (default: 10).
              </p>
            </div>

            <div>
              <Label htmlFor="login_ban_duration_minutes">Ban Duration (minutes)</Label>
              <Input
                id="login_ban_duration_minutes"
                name="login_ban_duration_minutes"
                type="number"
                min={1}
                defaultValue={currentSettings.login_ban_duration_minutes ?? "10"}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                How long an IP is banned after exceeding max attempts (default: 10).
              </p>
            </div>

            <div>
              <Label htmlFor="config_version_retention_days">Config Version Retention (days)</Label>
              <Input
                id="config_version_retention_days"
                name="config_version_retention_days"
                type="number"
                min={1}
                defaultValue={currentSettings.config_version_retention_days ?? "30"}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Config versions older than this are pruned (default: 30).
              </p>
            </div>

            <Separator />

            <div>
              <Label htmlFor="dns_resolver">DNS Resolver</Label>
              <Input
                id="dns_resolver"
                name="dns_resolver"
                type="text"
                defaultValue={currentSettings.dns_resolver ?? ""}
                placeholder="127.0.0.11"
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Resolver IP for dynamic DNS in proxy locations with a single upstream.
                Use 127.0.0.11 for Docker. Leave empty to disable.
              </p>
            </div>

            <div>
              <Label htmlFor="dns_resolver_valid">Resolver TTL</Label>
              <Input
                id="dns_resolver_valid"
                name="dns_resolver_valid"
                type="text"
                defaultValue={currentSettings.dns_resolver_valid ?? "30s"}
                placeholder="30s"
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                How long resolved addresses are cached (default: 30s).
              </p>
            </div>

            <Separator />

            <div>
              <Button type="submit" disabled={isSubmitting} className="press-effect">
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isSubmitting ? "Saving..." : "Save Settings"}
              </Button>
            </div>
          </Form>
        </CardContent>
      </Card>

      <ExportImportSection />
    </div>
  );
}

function ExportImportSection() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<Record<string, number> | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [importPassword, setImportPassword] = useState("");

  function handleExport() {
    let url = "/api/export";
    if (exportPassword) {
      url += `?password=${encodeURIComponent(exportPassword)}`;
    }
    window.location.href = url;
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setImportPreview(null);
    setImportId(null);

    try {
      let res: Response;

      if (file.name.endsWith(".json")) {
        // Legacy JSON format
        const text = await file.text();
        res = await fetch("/api/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: text,
        });
      } else {
        // tar.gz or encrypted format: send as FormData
        const formData = new FormData();
        formData.append("file", file);
        if (importPassword) {
          formData.append("password", importPassword);
        }
        res = await fetch("/api/import", {
          method: "POST",
          body: formData,
        });
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Import failed" }));
        toast.error(err.error || "Import failed");
        return;
      }

      const data = await res.json();
      if (data.importId) {
        setImportId(data.importId);
      }
      // Build preview counts from the known numeric fields
      const { importId: _id, version: _v, exportedAt: _e, configFilesList: _l, ...counts } = data;
      setImportPreview(counts);
      toast.success("Import preview ready.");
    } catch {
      toast.error("Failed to read or upload file.");
    } finally {
      setIsImporting(false);
    }
  }

  async function handleApplyImport() {
    setIsApplying(true);
    try {
      const body: Record<string, string> = {};
      if (importId) {
        body.importId = importId;
      }

      const res = await fetch("/api/import-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Apply failed" }));
        toast.error(err.error || "Apply failed");
        return;
      }

      toast.success("Import applied successfully.");
      setImportPreview(null);
      setImportId(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch {
      toast.error("Failed to apply import.");
    } finally {
      setIsApplying(false);
    }
  }

  return (
    <Card glass className="mt-6">
      <CardHeader>
        <CardTitle>Export & Import</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <div>
            <Label htmlFor="export-password">Export Encryption Password (optional)</Label>
            <div className="flex items-center gap-2 mt-1">
              <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <Input
                id="export-password"
                type="password"
                placeholder="Leave empty for unencrypted backup"
                value={exportPassword}
                onChange={(e) => setExportPassword(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              If set, the backup will be encrypted with AES-256-GCM. You will need this password to import the backup.
            </p>
          </div>
          <Button variant="outline" onClick={handleExport}>
            <Download className="mr-2 h-4 w-4" />
            {exportPassword ? "Export Encrypted Backup" : "Export Backup"}
          </Button>
        </div>

        <Separator />

        <div className="space-y-4">
          <div>
            <Label htmlFor="import-password">Import Decryption Password (optional)</Label>
            <div className="flex items-center gap-2 mt-1">
              <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <Input
                id="import-password"
                type="password"
                placeholder="Required only for encrypted backups"
                value={importPassword}
                onChange={(e) => setImportPassword(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Provide the password if the backup file is encrypted.
            </p>
          </div>
          <div>
            <Label htmlFor="import-file">Import Backup File</Label>
            <Input
              ref={fileInputRef}
              id="import-file"
              type="file"
              accept=".json,.tar.gz,.gz,.enc"
              onChange={handleImportFile}
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Select a backup file (.tar.gz, .tar.gz.enc, or legacy .json) previously exported from Nginx Manager.
            </p>
          </div>

          {isImporting && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Processing import...
            </div>
          )}

          {importPreview && (
            <div className="space-y-3">
              <p className="text-sm font-medium">Preview of items to import:</p>
              <div className="flex flex-wrap gap-2">
                {Object.entries(importPreview).map(([key, count]) => (
                  <Badge key={key} variant="secondary">
                    {key}: {String(count)}
                  </Badge>
                ))}
              </div>
              <Button onClick={handleApplyImport} disabled={isApplying}>
                {isApplying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Upload className="mr-2 h-4 w-4" />
                {isApplying ? "Applying..." : "Apply Import"}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
