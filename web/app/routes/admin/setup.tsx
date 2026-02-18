import type { Route } from "./+types/setup";
import { Form, redirect, useActionData, useNavigation } from "react-router";
import { db } from "~/lib/db/connection";
import { users } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth } from "~/lib/auth/middleware";
import { createToken } from "~/lib/auth/jwt.server";
import { createSessionCookie } from "~/lib/auth/session.server";
import { logAudit } from "~/lib/audit/log";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Button } from "~/components/ui/button";
import { Hexagon, Loader2 } from "lucide-react";

export function meta() {
  return [{ title: "Initial Setup — Nginx Manager" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUser = await requireAuth(request);
  const user = db.select().from(users).where(eq(users.id, currentUser.userId)).get();
  if (!user?.mustChangePassword) {
    throw redirect("/admin");
  }
  return { email: user.email };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUser = await requireAuth(request);
  const formData = await request.formData();
  const ipAddress = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";

  const email = (formData.get("email") as string)?.trim();
  const newPassword = formData.get("newPassword") as string;
  const confirmPassword = formData.get("confirmPassword") as string;

  if (!email || !newPassword || !confirmPassword) {
    return { error: "All fields are required" };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Invalid email format" };
  }

  if (newPassword !== confirmPassword) {
    return { error: "Passwords do not match" };
  }

  if (newPassword.length < 8) {
    return { error: "Password must be at least 8 characters" };
  }

  const existing = db.select().from(users).where(eq(users.email, email)).get();
  if (existing && existing.id !== currentUser.userId) {
    return { error: "A user with this email already exists" };
  }

  const hashedPassword = await Bun.password.hash(newPassword, {
    algorithm: "argon2id",
  });

  db.update(users)
    .set({
      email,
      password: hashedPassword,
      mustChangePassword: false,
      updatedAt: new Date(),
    })
    .where(eq(users.id, currentUser.userId))
    .run();

  logAudit({
    userId: currentUser.userId,
    action: "update",
    entity: "user",
    entityId: currentUser.userId,
    details: { email, setup: true },
    ipAddress,
  });

  const token = await createToken({
    userId: currentUser.userId,
    email,
    role: currentUser.role,
  });

  return redirect("/admin", {
    headers: {
      "Set-Cookie": createSessionCookie(token, request),
    },
  });
}

export default function SetupPage({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <Hexagon className="h-8 w-8 text-primary mx-auto" />
          <CardTitle>Initial Setup</CardTitle>
          <CardDescription>
            Set your admin email and password to get started.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {actionData && "error" in actionData && actionData.error && (
            <div className="bg-destructive/10 text-destructive border border-destructive/20 p-3 rounded-md mb-4 text-sm">
              {actionData.error}
            </div>
          )}

          <Form method="post" className="space-y-4">
            <div>
              <Label htmlFor="email" className="mb-1">
                Email
              </Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                autoFocus
                defaultValue={loaderData.email}
              />
            </div>

            <div>
              <Label htmlFor="newPassword" className="mb-1">
                New Password
              </Label>
              <Input
                id="newPassword"
                name="newPassword"
                type="password"
                required
                minLength={8}
                placeholder="Min. 8 characters"
              />
            </div>

            <div>
              <Label htmlFor="confirmPassword" className="mb-1">
                Confirm Password
              </Label>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                required
                minLength={8}
              />
            </div>

            <Button className="w-full" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Complete Setup"
              )}
            </Button>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
