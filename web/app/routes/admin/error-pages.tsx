import type { Route } from "./+types/error-pages";
import { Form, useActionData, useNavigation } from "react-router";
import { db } from "~/lib/db/connection";
import { hosts, hostGroups } from "~/lib/db/schema";
import { useState, useEffect } from "react";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "fs";
import { generateAllConfigs } from "~/lib/nginx/generator";
import { reloadNginx } from "~/lib/nginx/reload";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { PageHeader } from "~/components/PageHeader";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { toast } from "sonner";

const ERROR_PAGES_DIR = "/data/error-pages";
const ERROR_CODES = ["404", "500", "502", "503", "504"];

export function meta() {
  return [{ title: "Error Pages — Nginx Manager" }];
}

export async function loader({}: Route.LoaderArgs) {
  const groups = db.select().from(hostGroups).all();
  const allHosts = db.select().from(hosts).all();
  return { groups, hosts: allHosts };
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "load") {
    const scope = formData.get("scope") as string;
    const scopeId = formData.get("scopeId") as string;
    const code = formData.get("code") as string;

    const dir = getScopeDir(scope, scopeId);
    const filePath = `${dir}/${code}.html`;

    let content = "";
    try {
      if (existsSync(filePath)) {
        content = readFileSync(filePath, "utf-8");
      }
    } catch {
      // File doesn't exist yet
    }

    return { content, loaded: true };
  }

  if (intent === "save") {
    const scope = formData.get("scope") as string;
    const scopeId = formData.get("scopeId") as string;
    const code = formData.get("code") as string;
    const content = formData.get("content") as string;

    const dir = getScopeDir(scope, scopeId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${code}.html`, content, "utf-8");

    generateAllConfigs();
    const v = validateNginxConfig();
    if (!v.valid) return { error: "Config validation failed: " + v.error };
    reloadNginx();

    return { saved: true };
  }

  return {};
}

function getScopeDir(scope: string, scopeId: string): string {
  if (scope === "group") {
    return `${ERROR_PAGES_DIR}/group-${scopeId}`;
  }
  if (scope === "host") {
    return `${ERROR_PAGES_DIR}/host-${scopeId}`;
  }
  return `${ERROR_PAGES_DIR}/global`;
}

export default function ErrorPagesPage({ loaderData }: Route.ComponentProps) {
  const { groups, hosts } = loaderData;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [scope, setScope] = useState("global");
  const [scopeId, setScopeId] = useState("");
  const [code, setCode] = useState("404");
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);

  // Update content when loaded from server
  if (actionData && "content" in actionData && actionData.loaded && !loaded) {
    setContent(actionData.content as string);
    setLoaded(true);
  }

  useEffect(() => {
    if (actionData && "saved" in actionData && actionData.saved) {
      toast.success("Saved successfully.");
    }
  }, [actionData]);

  const handleLoad = () => {
    setLoaded(false);
  };

  return (
    <div>
      <PageHeader
        title="Error Pages"
        description="Custom error response pages"
      />

      <Card glass>
        <CardHeader>
          <CardTitle>Error Pages</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
            <div>
              <Label htmlFor="scope">Scope</Label>
              <select
                id="scope"
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value);
                  setScopeId("");
                  setLoaded(false);
                }}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring mt-1"
              >
                <option value="global">Global</option>
                <option value="group">Group</option>
                <option value="host">Host</option>
              </select>
            </div>

            {scope === "group" && (
              <div>
                <Label htmlFor="scopeId">Group</Label>
                <select
                  id="scopeId"
                  value={scopeId}
                  onChange={(e) => {
                    setScopeId(e.target.value);
                    setLoaded(false);
                  }}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring mt-1"
                >
                  <option value="">Select a group</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {scope === "host" && (
              <div>
                <Label htmlFor="scopeId">Host</Label>
                <select
                  id="scopeId"
                  value={scopeId}
                  onChange={(e) => {
                    setScopeId(e.target.value);
                    setLoaded(false);
                  }}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring mt-1"
                >
                  <option value="">Select a host</option>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {(h.domains as string[]).join(", ")}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <Label htmlFor="code">Error Code</Label>
              <select
                id="code"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setLoaded(false);
                }}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring mt-1"
              >
                {ERROR_CODES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <Form method="post" className="mb-6">
            <input type="hidden" name="intent" value="load" />
            <input type="hidden" name="scope" value={scope} />
            <input type="hidden" name="scopeId" value={scopeId} />
            <input type="hidden" name="code" value={code} />
            <Button
              type="submit"
              variant="outline"
              onClick={handleLoad}
              disabled={isSubmitting || (scope !== "global" && !scopeId)}
            >
              Load
            </Button>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="save" />
            <input type="hidden" name="scope" value={scope} />
            <input type="hidden" name="scopeId" value={scopeId} />
            <input type="hidden" name="code" value={code} />

            <div className="mb-4">
              <Label htmlFor="content">HTML Content</Label>
              <Textarea
                id="content"
                name="content"
                rows={20}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className="mt-1 font-mono text-sm"
                placeholder={"<!DOCTYPE html>\n<html>\n<head><title>Error</title></head>\n<body>\n  <h1>Error</h1>\n</body>\n</html>"}
              />
            </div>

            <Button
              type="submit"
              disabled={isSubmitting || (scope !== "global" && !scopeId)}
              className="press-effect"
            >
              Save
            </Button>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
