import type { Route } from "./+types/default-page";
import { Form, useActionData, useNavigation } from "react-router";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { PageHeader } from "~/components/PageHeader";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { toast } from "sonner";

const DEFAULT_PAGE_DIR = "/data/default-page";
const DEFAULT_PAGE_PATH = `${DEFAULT_PAGE_DIR}/index.html`;

export function meta() {
  return [{ title: "Default Page — Nginx Manager" }];
}

export async function loader({}: Route.LoaderArgs) {
  let content = "";
  try {
    if (existsSync(DEFAULT_PAGE_PATH)) {
      content = readFileSync(DEFAULT_PAGE_PATH, "utf-8");
    }
  } catch {
    // File doesn't exist yet
  }
  return { content };
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const content = formData.get("content") as string;

  mkdirSync(DEFAULT_PAGE_DIR, { recursive: true });
  writeFileSync(DEFAULT_PAGE_PATH, content, "utf-8");

  return { saved: true };
}

export default function DefaultPageEditor({ loaderData }: Route.ComponentProps) {
  const { content } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  useEffect(() => {
    if (actionData?.saved) {
      toast.success("Saved successfully.");
    }
  }, [actionData]);

  return (
    <div>
      <PageHeader
        title="Default Page"
        description="Customize the default nginx response"
      />

      <Card glass>
        <CardHeader>
          <CardTitle>Default Page</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            This page is displayed when no proxy host matches the incoming request.
          </p>

          <Form method="post">
            <div className="mb-4">
              <Label htmlFor="content">HTML Content</Label>
              <Textarea
                id="content"
                name="content"
                rows={24}
                defaultValue={content}
                className="mt-1 font-mono text-sm"
                placeholder={"<!DOCTYPE html>\n<html>\n<head><title>Welcome</title></head>\n<body>\n  <h1>Welcome to Nginx Manager</h1>\n</body>\n</html>"}
              />
            </div>

            <Button type="submit" disabled={isSubmitting} className="press-effect">
              {isSubmitting ? "Saving..." : "Save"}
            </Button>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
