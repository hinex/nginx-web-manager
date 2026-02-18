import { useState } from "react";
import { Form, redirect, useActionData, useNavigation } from "react-router";
import type { Route } from "./+types/login";
import { db } from "~/lib/db/connection";
import { users, userTotpSecrets, userWebauthnCredentials } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { createToken } from "~/lib/auth/jwt.server";
import {
  createSessionCookie,
  getSessionUser,
} from "~/lib/auth/session.server";
import { createChallengeToken } from "~/lib/auth/challenge";
import { logAudit } from "~/lib/audit/log";
import { getClientIp } from "~/lib/auth/middleware";
import {
  checkRateLimit,
  recordFailedAttempt,
  resetAttempts,
} from "~/lib/auth/rate-limit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Button } from "~/components/ui/button";
import { Server, Loader2, ShieldCheck, KeyRound, Fingerprint } from "lucide-react";

export function meta() {
  return [{ title: "Login — Nginx Manager" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getSessionUser(request);
  if (user) throw redirect("/admin");
  return {};
}

export async function action({ request }: Route.ActionArgs) {
  const clientIp = getClientIp(request);

  // Check rate limit before processing login
  const rateCheck = checkRateLimit(clientIp);
  if (!rateCheck.allowed) {
    const retryMinutes = Math.ceil((rateCheck.retryAfterMs ?? 0) / 60_000);
    return {
      error: `Too many failed login attempts. Please try again in ${retryMinutes} minute${retryMinutes === 1 ? "" : "s"}.`,
    };
  }

  const formData = await request.formData();
  const email = (formData.get("email") as string)?.trim();
  const password = formData.get("password") as string;

  if (!email || !password) {
    return { error: "Email and password are required" };
  }

  const user = db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .get();

  if (!user) {
    recordFailedAttempt(clientIp);
    return { error: "Invalid credentials" };
  }

  const valid = await Bun.password.verify(password, user.password);
  if (!valid) {
    recordFailedAttempt(clientIp);
    return { error: "Invalid credentials" };
  }

  // Credentials valid — reset rate limit counter
  resetAttempts(clientIp);

  // Check if user has 2FA enabled
  const totp = db
    .select()
    .from(userTotpSecrets)
    .where(eq(userTotpSecrets.userId, user.id))
    .get();

  const webauthnCreds = db
    .select()
    .from(userWebauthnCredentials)
    .where(eq(userWebauthnCredentials.userId, user.id))
    .all();

  const hasTOTP = totp?.verified === true;
  const hasWebAuthn = webauthnCreds.length > 0;

  if (hasTOTP || hasWebAuthn) {
    // 2FA is enabled: issue a short-lived challenge token
    const challengeToken = await createChallengeToken(user.id);
    const methods: string[] = [];
    if (hasTOTP) methods.push("totp");
    if (hasWebAuthn) methods.push("webauthn");

    return {
      requires2fa: true,
      challengeToken,
      methods,
    };
  }

  // No 2FA: proceed with normal login
  const token = await createToken({
    userId: user.id,
    email: user.email,
    role: user.role,
  });

  logAudit({
    userId: user.id,
    action: "login",
    entity: "user",
    entityId: user.id,
    details: { email: user.email },
    ipAddress: clientIp,
  });

  const redirectTo = user.mustChangePassword ? "/admin/setup" : "/admin";

  return redirect(redirectTo, {
    headers: {
      "Set-Cookie": createSessionCookie(token, request),
    },
  });
}

export default function LoginPage() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  if (actionData && "requires2fa" in actionData && actionData.requires2fa) {
    return (
      <TwoFactorStep
        challengeToken={actionData.challengeToken as string}
        methods={actionData.methods as string[]}
      />
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center login-gradient p-4">
      <Card className="w-full max-w-sm glass-card animate-fade-in-up">
        <CardHeader className="text-center">
          <div className="h-14 w-14 rounded-2xl icon-gradient-blue flex items-center justify-center mx-auto">
            <Server className="h-7 w-7 text-white" />
          </div>
          <CardTitle className="gradient-text">Nginx Manager</CardTitle>
          <CardDescription>Sign in to your account</CardDescription>
        </CardHeader>
        <CardContent>
          {actionData && "error" in actionData && actionData.error && (
            <div className="bg-destructive/10 text-destructive border border-destructive/20 p-3 rounded-md mb-4 text-sm">
              {actionData.error}
            </div>
          )}

          <Form method="post" className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                name="email"
                required
                autoFocus
                placeholder="admin@example.com"
              />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                name="password"
                required
                placeholder="••••••••"
              />
            </div>
            <Button type="submit" className="w-full press-effect" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                "Sign In"
              )}
            </Button>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}

function TwoFactorStep({
  challengeToken,
  methods,
}: {
  challengeToken: string;
  methods: string[];
}) {
  const [activeMethod, setActiveMethod] = useState<string>(methods[0]);
  const [totpCode, setTotpCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleTotpVerify(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/totp-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken, code: totpCode }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        window.location.href = "/admin";
      } else {
        setError(data.error || "Verification failed");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleWebAuthnVerify() {
    setLoading(true);
    setError(null);

    try {
      // Step 1: Get authentication options from the server
      const challengeRes = await fetch("/api/webauthn-challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken }),
      });

      if (!challengeRes.ok) {
        const data = await challengeRes.json();
        setError(data.error || "Failed to get challenge");
        setLoading(false);
        return;
      }

      const options = await challengeRes.json();

      // Step 2: Trigger browser WebAuthn authentication
      const { startAuthentication } = await import("@simplewebauthn/browser");
      const authResponse = await startAuthentication({ optionsJSON: options });

      // Step 3: Verify with server
      const verifyRes = await fetch("/api/webauthn-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken, response: authResponse }),
      });

      const verifyData = await verifyRes.json();
      if (verifyRes.ok && verifyData.success) {
        window.location.href = "/admin";
      } else {
        setError(verifyData.error || "Verification failed");
      }
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Authentication was cancelled or timed out.");
      } else {
        setError("WebAuthn authentication failed. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center login-gradient p-4">
      <Card className="w-full max-w-sm glass-card animate-fade-in-up">
        <CardHeader className="text-center">
          <div className="h-14 w-14 rounded-2xl icon-gradient-purple flex items-center justify-center mx-auto">
            <ShieldCheck className="h-7 w-7 text-white" />
          </div>
          <CardTitle className="gradient-text">Two-Factor Authentication</CardTitle>
          <CardDescription>
            Verify your identity to continue
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="bg-destructive/10 text-destructive border border-destructive/20 p-3 rounded-md mb-4 text-sm">
              {error}
            </div>
          )}

          {methods.length > 1 && (
            <div className="flex gap-2 mb-4">
              {methods.includes("totp") && (
                <Button
                  variant={activeMethod === "totp" ? "default" : "outline"}
                  size="sm"
                  className="flex-1 press-effect"
                  onClick={() => {
                    setActiveMethod("totp");
                    setError(null);
                  }}
                  disabled={loading}
                >
                  <KeyRound className="mr-2 h-4 w-4" />
                  Authenticator
                </Button>
              )}
              {methods.includes("webauthn") && (
                <Button
                  variant={activeMethod === "webauthn" ? "default" : "outline"}
                  size="sm"
                  className="flex-1 press-effect"
                  onClick={() => {
                    setActiveMethod("webauthn");
                    setError(null);
                  }}
                  disabled={loading}
                >
                  <Fingerprint className="mr-2 h-4 w-4" />
                  Passkey
                </Button>
              )}
            </div>
          )}

          {activeMethod === "totp" && (
            <form onSubmit={handleTotpVerify} className="space-y-4">
              <div>
                <Label htmlFor="totp-code">Authentication Code</Label>
                <Input
                  id="totp-code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder="000000"
                  value={totpCode}
                  onChange={(e) =>
                    setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Enter the 6-digit code from your authenticator app
                </p>
              </div>
              <Button
                type="submit"
                className="w-full press-effect"
                disabled={loading || totpCode.length !== 6}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Verifying...
                  </>
                ) : (
                  "Verify Code"
                )}
              </Button>
            </form>
          )}

          {activeMethod === "webauthn" && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground text-center">
                Use your passkey, security key, or biometric authenticator to
                verify your identity.
              </p>
              <Button
                className="w-full press-effect"
                onClick={handleWebAuthnVerify}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Waiting for authenticator...
                  </>
                ) : (
                  <>
                    <Fingerprint className="mr-2 h-4 w-4" />
                    Authenticate with Passkey
                  </>
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
