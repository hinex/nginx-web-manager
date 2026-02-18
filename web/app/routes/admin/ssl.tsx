import type { Route } from "./+types/ssl";
import { db } from "~/lib/db/connection";
import { hosts } from "~/lib/db/schema";
import { existsSync, readFileSync } from "fs";
import { useFetcher } from "react-router";
import { useState, useEffect } from "react";
import { requireEditor } from "~/lib/auth/middleware";
import { eq } from "drizzle-orm";
import { generateAllConfigs } from "~/lib/nginx/generator";
import { reloadNginx } from "~/lib/nginx/reload";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { requestCertificate } from "~/lib/acme/client";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import { RefreshCw, Upload } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "~/components/PageHeader";

function getCertExpiry(certPath: string): string | null {
  try {
    if (!existsSync(certPath)) return null;
    // Read PEM and extract notAfter via a simple regex on the base64 content
    // Since we can't use openssl, we'll just report if the file exists
    return "Certificate present";
  } catch {
    return null;
  }
}

export function meta() {
  return [{ title: "SSL Certificates — Nginx Manager" }];
}

export async function loader({}: Route.LoaderArgs) {
  const allHosts = db.select().from(hosts).all();
  const sslHosts = allHosts
    .filter((h) => h.sslType !== "none")
    .map((h) => {
      const domains = h.domains as string[];
      const certStatus = h.sslCertPath ? getCertExpiry(h.sslCertPath) : null;
      return {
        id: h.id,
        domains,
        sslType: h.sslType,
        sslCertPath: h.sslCertPath,
        sslKeyPath: h.sslKeyPath,
        certStatus,
        enabled: h.enabled,
      };
    });

  return { sslHosts };
}

export async function action({ request }: Route.ActionArgs) {
  await requireEditor(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "upload") {
    const id = Number(formData.get("id"));
    const certPath = formData.get("certPath") as string;
    const keyPath = formData.get("keyPath") as string;

    if (!certPath || !keyPath) {
      return { error: "Certificate and key paths are required" };
    }

    db.update(hosts)
      .set({
        sslType: "custom",
        sslCertPath: certPath,
        sslKeyPath: keyPath,
        updatedAt: new Date(),
      })
      .where(eq(hosts.id, id))
      .run();

    generateAllConfigs();
    const v = validateNginxConfig();
    if (!v.valid) return { error: "Config validation failed: " + v.error };
    reloadNginx();
  }

  if (intent === "request") {
    const id = Number(formData.get("id"));
    const host = db.select().from(hosts).where(eq(hosts.id, id)).get();
    if (!host) {
      return { error: "Host not found" };
    }

    const domains = host.domains as string[];
    const staging = formData.get("staging") === "true";
    const result = await requestCertificate(domains, staging);

    if (result.success && result.certPath && result.keyPath) {
      db.update(hosts)
        .set({
          sslCertPath: result.certPath,
          sslKeyPath: result.keyPath,
          updatedAt: new Date(),
        })
        .where(eq(hosts.id, id))
        .run();

      generateAllConfigs();
      const v = validateNginxConfig();
      if (!v.valid) return { error: "Config validation failed: " + v.error };
      reloadNginx();

      return { ok: true, certResult: result };
    }

    return { error: result.error, certResult: result };
  }

  return { ok: true };
}

export default function SSLPage({ loaderData }: Route.ComponentProps) {
  const { sslHosts } = loaderData;
  const [uploadModal, setUploadModal] = useState<number | null>(null);
  const requestFetcher = useFetcher();
  const isRequesting = requestFetcher.state !== "idle";
  const requestResult = requestFetcher.data as
    | { ok?: boolean; error?: string; certResult?: { success: boolean; error?: string } }
    | undefined;

  useEffect(() => {
    if (!requestResult) return;
    if (requestResult.error) {
      toast.error(requestResult.error);
    } else if (requestResult.ok && requestResult.certResult?.success) {
      toast.success("Certificate configured successfully. Nginx has been reloaded.");
    }
  }, [requestResult]);

  return (
    <div>
      <PageHeader
        title="SSL Certificates"
        description="Manage TLS certificates and ACME automation"
      />

      {sslHosts.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          No proxy hosts with SSL enabled.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Domains</TableHead>
                <TableHead>SSL Type</TableHead>
                <TableHead>Certificate Path</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sslHosts.map((host) => (
                <TableRow key={host.id} className="hover:bg-muted/30 transition-colors">
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {host.domains.map((d, i) => (
                        <Badge key={i} variant="outline">{d}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {host.sslType === "letsencrypt"
                        ? "Let's Encrypt"
                        : host.sslType === "custom"
                          ? "Custom"
                          : "None"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs font-mono text-muted-foreground">
                      {host.sslCertPath || "-"}
                    </code>
                  </TableCell>
                  <TableCell>
                    {host.certStatus ? (
                      <Badge>Certificate present</Badge>
                    ) : (
                      <Badge variant="secondary">No certificate</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {host.sslType === "letsencrypt" && (
                        <requestFetcher.Form method="post" className="inline">
                          <input type="hidden" name="intent" value="request" />
                          <input type="hidden" name="id" value={String(host.id)} />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="sm"
                            disabled={isRequesting}
                          >
                            <RefreshCw className={`mr-2 h-4 w-4 ${isRequesting ? "animate-spin" : ""}`} />
                            {isRequesting ? "Requesting..." : "Request Certificate"}
                          </Button>
                        </requestFetcher.Form>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setUploadModal(host.id)}
                      >
                        <Upload className="mr-2 h-4 w-4" />
                        Upload Custom
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <UploadModal
        hostId={uploadModal}
        open={uploadModal !== null}
        onClose={() => setUploadModal(null)}
      />
    </div>
  );
}

function UploadModal({
  hostId,
  open,
  onClose,
}: {
  hostId: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const certPath = (form.get("certPath") as string)?.trim();
    const keyPath = (form.get("keyPath") as string)?.trim();

    if (!certPath) {
      toast.error("Certificate path is required");
      return;
    }
    if (!certPath.startsWith("/")) {
      toast.error("Certificate path must be an absolute path");
      return;
    }
    if (!keyPath) {
      toast.error("Key path is required");
      return;
    }
    if (!keyPath.startsWith("/")) {
      toast.error("Key path must be an absolute path");
      return;
    }

    fetcher.submit(form, { method: "post" });
  };

  useEffect(() => {
    if (fetcher.data?.error) {
      toast.error(fetcher.data.error);
    } else if (fetcher.data?.ok) {
      toast.success("Certificate paths updated");
      onClose();
    }
  }, [fetcher.data]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload Custom Certificate</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <input type="hidden" name="intent" value="upload" />
          <input type="hidden" name="id" value={String(hostId ?? 0)} />

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="certPath">Certificate Path</Label>
              <Input
                id="certPath"
                name="certPath"
                type="text"
                required
                placeholder="/etc/ssl/certs/example.crt"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="keyPath">Key Path</Label>
              <Input
                id="keyPath"
                name="keyPath"
                type="text"
                required
                placeholder="/etc/ssl/private/example.key"
              />
            </div>
          </div>

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting} className="press-effect">
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
