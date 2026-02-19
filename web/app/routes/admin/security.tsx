import type { Route } from "./+types/security";
import { useState, useEffect, useCallback } from "react";
import { requireAuth } from "~/lib/auth/middleware";
import { db } from "~/lib/db/connection";
import { userTotpSecrets, userWebauthnCredentials, userRecoveryCodes } from "~/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Badge } from "~/components/ui/badge";
import { Separator } from "~/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  Loader2,
  Smartphone,
  Fingerprint,
  KeyRound,
  Trash2,
  Plus,
  Copy,
  Download,
  AlertTriangle,
} from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";
import { PageHeader } from "~/components/PageHeader";

export function meta() {
  return [{ title: "Security — Nginx Manager" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireAuth(request);

  const totp = db
    .select()
    .from(userTotpSecrets)
    .where(eq(userTotpSecrets.userId, user.userId))
    .get();

  const passkeys = db
    .select()
    .from(userWebauthnCredentials)
    .where(eq(userWebauthnCredentials.userId, user.userId))
    .all()
    .map((c) => ({
      id: c.id,
      deviceName: c.deviceName ?? "Passkey",
      createdAt: c.createdAt,
    }));

  const recoveryCodesRemaining = db
    .select()
    .from(userRecoveryCodes)
    .where(
      and(
        eq(userRecoveryCodes.userId, user.userId),
        eq(userRecoveryCodes.used, false)
      )
    )
    .all().length;

  return {
    totpEnabled: totp?.verified ?? false,
    passkeys,
    recoveryCodesRemaining,
  };
}

export default function SecurityPage({ loaderData }: Route.ComponentProps) {
  const { totpEnabled, passkeys, recoveryCodesRemaining } = loaderData;

  return (
    <div>
      <PageHeader
        title="Security"
        description="Two-factor authentication and passkeys"
      />

      <div className="space-y-6">
        <TotpSection enabled={totpEnabled} />
        <WebAuthnSection passkeys={passkeys} />
        <RecoveryCodesSection remaining={recoveryCodesRemaining} />
      </div>
    </div>
  );
}

// ─── TOTP Section ─────────────────────────────────────────

function TotpSection({ enabled: initialEnabled }: { enabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [loading, setLoading] = useState(false);
  const [setupData, setSetupData] = useState<{
    secret: string;
    qrCode: string;
  } | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/totp-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate" }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to generate TOTP secret");
        return;
      }
      setSetupData({ secret: data.secret, qrCode: data.qrCode });
    } catch {
      toast.error("Failed to generate TOTP secret");
    } finally {
      setLoading(false);
    }
  };

  const handleEnable = async () => {
    if (!verifyCode || verifyCode.length !== 6) {
      toast.error("Please enter a 6-digit verification code");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/totp-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enable", code: verifyCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to enable TOTP");
        return;
      }
      toast.success("TOTP enabled successfully");
      setEnabled(true);
      setSetupData(null);
      setVerifyCode("");
    } catch {
      toast.error("Failed to enable TOTP");
    } finally {
      setLoading(false);
    }
  };

  const handleDisable = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/totp-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disable" }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to disable TOTP");
        return;
      }
      toast.success("TOTP disabled");
      setEnabled(false);
      setSetupData(null);
      setShowDisableConfirm(false);
    } catch {
      toast.error("Failed to disable TOTP");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card glass>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Smartphone className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle>Authenticator App (TOTP)</CardTitle>
              <CardDescription className="mt-1">
                Use an authenticator app to generate time-based one-time passwords.
              </CardDescription>
            </div>
          </div>
          <Badge variant={enabled ? "default" : "secondary"}>
            {enabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {enabled && !setupData ? (
          <Button
            variant="destructive"
            onClick={() => setShowDisableConfirm(true)}
            disabled={loading}
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Disable TOTP
          </Button>
        ) : setupData ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Scan this QR code with your authenticator app (e.g. Google Authenticator, Authy):
            </p>
            <div className="flex justify-center">
              <img
                src={setupData.qrCode}
                alt="TOTP QR Code"
                className="rounded-lg border bg-white p-2"
                width={200}
                height={200}
              />
            </div>
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                Or enter this secret manually:
              </p>
              <code className="block rounded bg-muted px-3 py-2 text-sm font-mono break-all select-all">
                {setupData.secret}
              </code>
            </div>
            <Separator />
            <div className="space-y-2">
              <p className="text-sm font-medium">
                Enter the 6-digit code from your authenticator app to verify:
              </p>
              <div className="flex flex-wrap gap-2">
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="000000"
                  value={verifyCode}
                  onChange={(e) =>
                    setVerifyCode(e.target.value.replace(/\D/g, ""))
                  }
                  className="w-32 font-mono text-center text-lg tracking-widest"
                />
                <Button onClick={handleEnable} disabled={loading}>
                  {loading && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Verify & Enable
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSetupData(null);
                    setVerifyCode("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <Button onClick={handleGenerate} disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Enable TOTP
          </Button>
        )}

        <AlertDialog
          open={showDisableConfirm}
          onOpenChange={setShowDisableConfirm}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disable TOTP?</AlertDialogTitle>
              <AlertDialogDescription>
                This will remove the authenticator app from your account. You
                will no longer be prompted for a TOTP code during login.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDisable}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Disable TOTP
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// ─── WebAuthn Section ─────────────────────────────────────

interface PasskeyInfo {
  id: number;
  deviceName: string;
  createdAt: Date;
}

function WebAuthnSection({
  passkeys: initialPasskeys,
}: {
  passkeys: PasskeyInfo[];
}) {
  const [passkeys, setPasskeys] = useState(initialPasskeys);
  const [loading, setLoading] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [showNameInput, setShowNameInput] = useState(false);

  const handleRegister = useCallback(async () => {
    const name = deviceName.trim() || "Passkey";
    setLoading(true);
    try {
      // Step 1: Get registration options
      const optionsRes = await fetch("/api/webauthn-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "options" }),
      });
      const options = await optionsRes.json();
      if (!optionsRes.ok) {
        toast.error(options.error || "Failed to get registration options");
        return;
      }

      // Step 2: Start browser registration ceremony
      const registrationResponse = await startRegistration({ optionsJSON: options });

      // Step 3: Verify registration on server
      const verifyRes = await fetch("/api/webauthn-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "verify",
          response: registrationResponse,
          deviceName: name,
        }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyRes.ok) {
        toast.error(verifyData.error || "Failed to register passkey");
        return;
      }

      toast.success("Passkey registered successfully");
      setShowNameInput(false);
      setDeviceName("");
      // Reload to get updated passkey list
      window.location.reload();
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        toast.error("Registration was cancelled or not allowed");
      } else {
        toast.error("Failed to register passkey");
      }
    } finally {
      setLoading(false);
    }
  }, [deviceName]);

  const handleDelete = async (id: number) => {
    setLoading(true);
    try {
      const res = await fetch("/api/webauthn-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", credentialId: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to delete passkey");
        return;
      }
      toast.success("Passkey removed");
      setPasskeys((prev) => prev.filter((p) => p.id !== id));
      setDeleteId(null);
    } catch {
      toast.error("Failed to delete passkey");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card glass>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Fingerprint className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle>Passkeys (WebAuthn)</CardTitle>
              <CardDescription className="mt-1">
                Use a hardware security key or biometric authenticator for
                passwordless login.
              </CardDescription>
            </div>
          </div>
          <Badge variant={passkeys.length > 0 ? "default" : "secondary"}>
            {passkeys.length} registered
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {passkeys.length > 0 && (
          <div className="space-y-2">
            {passkeys.map((passkey) => (
              <div
                key={passkey.id}
                className="flex items-center justify-between rounded-md border px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium">{passkey.deviceName}</p>
                  <p className="text-xs text-muted-foreground">
                    Added {new Date(passkey.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteId(passkey.id)}
                  disabled={loading}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {showNameInput ? (
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Device name (e.g. YubiKey 5)"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              className="flex-1 min-w-[200px] max-w-xs"
            />
            <Button onClick={handleRegister} disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Register
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setShowNameInput(false);
                setDeviceName("");
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            onClick={() => setShowNameInput(true)}
            disabled={loading}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Passkey
          </Button>
        )}

        <AlertDialog
          open={deleteId !== null}
          onOpenChange={(open) => !open && setDeleteId(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove Passkey?</AlertDialogTitle>
              <AlertDialogDescription>
                This passkey will be removed from your account. You will no
                longer be able to use it for login.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteId !== null && handleDelete(deleteId)}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// ─── Recovery Codes Section ───────────────────────────────

function RecoveryCodesSection({ remaining: initialRemaining }: { remaining: number }) {
  const [remaining, setRemaining] = useState(initialRemaining);
  const [loading, setLoading] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/recovery-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate" }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to generate recovery codes");
        return;
      }
      setCodes(data.codes);
      setRemaining(data.codes.length);
      setShowRegenerateConfirm(false);
      toast.success("Recovery codes generated");
    } catch {
      toast.error("Failed to generate recovery codes");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!codes) return;
    const text = codes.join("\n");
    navigator.clipboard.writeText(text).then(
      () => toast.success("Codes copied to clipboard"),
      () => toast.error("Failed to copy codes")
    );
  };

  const handleDownload = () => {
    if (!codes) return;
    const text = codes.join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card glass>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle>Recovery Codes</CardTitle>
              <CardDescription className="mt-1">
                One-time use codes for account recovery if you lose access to
                your 2FA device.
              </CardDescription>
            </div>
          </div>
          <Badge variant={remaining > 0 ? "default" : "secondary"}>
            {remaining} remaining
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {codes ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600 dark:text-yellow-400" />
              <p className="text-sm text-yellow-800 dark:text-yellow-200">
                Save these codes now! They will not be shown again. Each code
                can only be used once.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {codes.map((code, i) => (
                <code
                  key={i}
                  className="rounded bg-muted px-3 py-2 text-center text-sm font-mono"
                >
                  {code}
                </code>
              ))}
            </div>

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleCopy}>
                <Copy className="mr-2 h-4 w-4" />
                Copy
              </Button>
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="mr-2 h-4 w-4" />
                Download
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCodes(null)}
              >
                Done
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant={remaining > 0 ? "outline" : "default"}
            onClick={() =>
              remaining > 0
                ? setShowRegenerateConfirm(true)
                : handleGenerate()
            }
            disabled={loading}
          >
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {remaining > 0 ? "Regenerate Codes" : "Generate Recovery Codes"}
          </Button>
        )}

        <AlertDialog
          open={showRegenerateConfirm}
          onOpenChange={setShowRegenerateConfirm}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Regenerate Recovery Codes?</AlertDialogTitle>
              <AlertDialogDescription>
                This will invalidate all existing recovery codes and generate
                new ones. Make sure to save the new codes.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleGenerate}>
                Regenerate
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
