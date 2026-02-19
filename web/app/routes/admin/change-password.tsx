import type { Route } from "./+types/change-password";
import { Form, redirect, useActionData, useNavigation } from "react-router";
import { db } from "~/lib/db/connection";
import { users } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth } from "~/lib/auth/middleware";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Button } from "~/components/ui/button";
import { Loader2 } from "lucide-react";
import { PageHeader } from "~/components/PageHeader";

export function meta() {
  return [{ title: "Change Password — Nginx Manager" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAuth(request);
  return {};
}

export async function action({ request }: Route.ActionArgs) {
  const currentUser = await requireAuth(request);
  const formData = await request.formData();

  const currentPassword = formData.get("currentPassword") as string;
  const newPassword = formData.get("newPassword") as string;
  const confirmPassword = formData.get("confirmPassword") as string;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return { error: "All fields are required" };
  }

  if (newPassword !== confirmPassword) {
    return { error: "New passwords do not match" };
  }

  if (newPassword.length < 8) {
    return { error: "New password must be at least 8 characters" };
  }

  const user = db
    .select()
    .from(users)
    .where(eq(users.id, currentUser.userId))
    .get();

  if (!user) {
    return { error: "User not found" };
  }

  const valid = await Bun.password.verify(currentPassword, user.password);
  if (!valid) {
    return { error: "Current password is incorrect" };
  }

  const hashedPassword = await Bun.password.hash(newPassword, {
    algorithm: "argon2id",
  });

  db.update(users)
    .set({
      password: hashedPassword,
      mustChangePassword: false,
      updatedAt: new Date(),
    })
    .where(eq(users.id, currentUser.userId))
    .run();

  return redirect("/admin");
}

export default function ChangePasswordPage() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div>
      <PageHeader
        title="Change Password"
        description="Update your account password"
        backHref="/admin/security"
      />
    <Card glass className="max-w-md">
      <CardHeader>
        <CardTitle>Change Password</CardTitle>
      </CardHeader>
      <CardContent>
        {actionData && "error" in actionData && actionData.error && (
          <div className="bg-destructive/10 text-destructive border border-destructive/20 p-3 rounded-md mb-4 text-sm">
            {actionData.error}
          </div>
        )}

        <Form method="post" className="space-y-4">
          <div>
            <Label htmlFor="currentPassword" className="mb-1">
              Current Password
            </Label>
            <Input
              id="currentPassword"
              name="currentPassword"
              type="password"
              required
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
            />
          </div>

          <div>
            <Label htmlFor="confirmPassword" className="mb-1">
              Confirm New Password
            </Label>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              required
              minLength={8}
            />
          </div>

          <Button className="w-full press-effect" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Changing...
              </>
            ) : (
              "Change Password"
            )}
          </Button>
        </Form>
      </CardContent>
    </Card>
    </div>
  );
}
