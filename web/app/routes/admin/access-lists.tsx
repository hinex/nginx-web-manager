import type { Route } from "./+types/access-lists";
import { Form, redirect, useActionData, useNavigation } from "react-router";
import { useFetcher } from "react-router";
import { db } from "~/lib/db/connection";
import { accessLists, accessListClients, accessListAuth } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { useState, useEffect } from "react";
import { requireEditor } from "~/lib/auth/middleware";
import { generateAllConfigs } from "~/lib/nginx/generator";
import { reloadNginx } from "~/lib/nginx/reload";
import { validateNginxConfig } from "~/lib/nginx/validator";
import { logAudit } from "~/lib/audit/log";
import { getSessionUser } from "~/lib/auth/session.server";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
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
import { Plus, MoreHorizontal, Pencil, Trash2, X, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "~/components/PageHeader";

export function meta() {
  return [{ title: "Access Lists — Nginx Manager" }];
}

export async function loader({}: Route.LoaderArgs) {
  const lists = db.select().from(accessLists).all();

  const enrichedLists = lists.map((list) => {
    const clients = db
      .select()
      .from(accessListClients)
      .where(eq(accessListClients.accessListId, list.id))
      .all();
    const auth = db
      .select()
      .from(accessListAuth)
      .where(eq(accessListAuth.accessListId, list.id))
      .all();
    return {
      ...list,
      clientCount: clients.length,
      authCount: auth.length,
      clients,
      auth,
    };
  });

  return { lists: enrichedLists };
}

export async function action({ request }: Route.ActionArgs) {
  await requireEditor(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const user = await getSessionUser(request);
  const ipAddress = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";

  if (intent === "create" || intent === "update") {
    const name = formData.get("name") as string;
    const satisfy = formData.get("satisfy") as string;
    const clientsJson = formData.get("clients") as string;
    const authJson = formData.get("auth") as string;

    if (!name) return { error: "Name is required" };
    if (name.length > 100) return { error: "Name must be 100 characters or less" };

    let clients: Array<{ address: string; directive: string }>;
    let authEntries: Array<{ username: string; password: string }>;
    try {
      clients = JSON.parse(clientsJson || "[]");
      authEntries = JSON.parse(authJson || "[]");
    } catch {
      return { error: "Invalid data format" };
    }

    if (intent === "create") {
      const result = db
        .insert(accessLists)
        .values({
          name,
          satisfy: satisfy as "any" | "all",
          createdAt: new Date(),
        })
        .returning()
        .get();

      for (const client of clients) {
        if (client.address.trim()) {
          db.insert(accessListClients)
            .values({
              accessListId: result.id,
              address: client.address.trim(),
              directive: client.directive as "allow" | "deny",
            })
            .run();
        }
      }

      for (const auth of authEntries) {
        if (auth.username.trim() && auth.password.trim()) {
          db.insert(accessListAuth)
            .values({
              accessListId: result.id,
              username: auth.username.trim(),
              password: auth.password.trim(),
            })
            .run();
        }
      }

      logAudit({
        userId: user?.userId ?? null,
        action: "create",
        entity: "access_list",
        entityId: result.id,
        details: { name },
        ipAddress,
      });
    } else {
      const id = Number(formData.get("id"));

      db.update(accessLists)
        .set({ name, satisfy: satisfy as "any" | "all" })
        .where(eq(accessLists.id, id))
        .run();

      // Replace clients and auth
      db.delete(accessListClients)
        .where(eq(accessListClients.accessListId, id))
        .run();
      db.delete(accessListAuth)
        .where(eq(accessListAuth.accessListId, id))
        .run();

      for (const client of clients) {
        if (client.address.trim()) {
          db.insert(accessListClients)
            .values({
              accessListId: id,
              address: client.address.trim(),
              directive: client.directive as "allow" | "deny",
            })
            .run();
        }
      }

      for (const auth of authEntries) {
        if (auth.username.trim() && auth.password.trim()) {
          db.insert(accessListAuth)
            .values({
              accessListId: id,
              username: auth.username.trim(),
              password: auth.password.trim(),
            })
            .run();
        }
      }

      logAudit({
        userId: user?.userId ?? null,
        action: "update",
        entity: "access_list",
        entityId: id,
        details: { name },
        ipAddress,
      });
    }

    generateAllConfigs();
    const v = validateNginxConfig();
    if (!v.valid) return { error: "Config validation failed: " + v.error };
    reloadNginx();
    return { ok: true };
  } else if (intent === "delete") {
    const id = Number(formData.get("id"));
    db.delete(accessLists).where(eq(accessLists.id, id)).run();

    logAudit({
      userId: user?.userId ?? null,
      action: "delete",
      entity: "access_list",
      entityId: id,
      ipAddress,
    });

    generateAllConfigs();
    const v = validateNginxConfig();
    if (!v.valid) return { error: "Config validation failed: " + v.error };
    reloadNginx();
  }

  return { ok: true };
}

export default function AccessListsPage({ loaderData }: Route.ComponentProps) {
  const { lists } = loaderData;
  const [editList, setEditList] = useState<(typeof lists)[0] | null>(null);
  const [showForm, setShowForm] = useState(false);

  const openCreate = () => {
    setEditList(null);
    setShowForm(true);
  };

  const openEdit = (list: (typeof lists)[0]) => {
    setEditList(list);
    setShowForm(true);
  };

  if (showForm) {
    return (
      <AccessListForm
        list={editList}
        onBack={() => setShowForm(false)}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Access Lists"
        description="Control access with IP allow/deny rules"
        actions={
          <Button onClick={openCreate} className="press-effect">
            <Plus className="mr-2 h-4 w-4" />
            Add Access List
          </Button>
        }
      />

      {lists.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          No access lists configured yet.
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Satisfy</TableHead>
                <TableHead>IP Rules</TableHead>
                <TableHead className="hidden sm:table-cell">Auth Entries</TableHead>
                <TableHead className="w-[70px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lists.map((list) => (
                <AccessListRow
                  key={list.id}
                  list={list}
                  onEdit={() => openEdit(list)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function AccessListRow({
  list,
  onEdit,
}: {
  list: {
    id: number;
    name: string;
    satisfy: string;
    clientCount: number;
    authCount: number;
  };
  onEdit: () => void;
}) {
  const deleteFetcher = useFetcher();
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <TableRow className="hover:bg-muted/30 transition-colors">
      <TableCell className="font-medium">{list.name}</TableCell>
      <TableCell>
        <Badge variant="secondary" className="capitalize">{list.satisfy}</Badge>
      </TableCell>
      <TableCell>{list.clientCount}</TableCell>
      <TableCell className="hidden sm:table-cell">{list.authCount}</TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => setShowConfirm(true)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm Delete</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete the access list &quot;{list.name}&quot;? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  deleteFetcher.submit(
                    { intent: "delete", id: String(list.id) },
                    { method: "post" }
                  );
                  setShowConfirm(false);
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </TableCell>
    </TableRow>
  );
}

function AccessListForm({
  list,
  onBack,
}: {
  list: {
    id: number;
    name: string;
    satisfy: string;
    clients: Array<{ id: number; address: string; directive: string }>;
    auth: Array<{ id: number; username: string; password: string }>;
  } | null;
  onBack: () => void;
}) {
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";

  const [clients, setClients] = useState<Array<{ address: string; directive: string }>>(
    list?.clients.map((c) => ({ address: c.address, directive: c.directive })) ?? [
      { address: "", directive: "allow" },
    ]
  );

  const [authEntries, setAuthEntries] = useState<
    Array<{ username: string; password: string }>
  >(
    list?.auth.map((a) => ({ username: a.username, password: "" })) ?? [
      { username: "", password: "" },
    ]
  );

  const addClient = () =>
    setClients([...clients, { address: "", directive: "allow" }]);
  const removeClient = (idx: number) =>
    setClients(clients.filter((_, i) => i !== idx));

  const addAuth = () =>
    setAuthEntries([...authEntries, { username: "", password: "" }]);
  const removeAuth = (idx: number) =>
    setAuthEntries(authEntries.filter((_, i) => i !== idx));

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const nameVal = (new FormData(e.currentTarget).get("name") as string)?.trim();
    if (!nameVal) {
      toast.error("Name is required");
      return;
    }

    const filledClients = clients.filter(c => c.address.trim());

    for (const auth of authEntries) {
      if (auth.username.trim() && !auth.password.trim() && !list) {
        toast.error("Password is required for new auth entries");
        return;
      }
    }

    const form = new FormData(e.currentTarget);
    form.set("clients", JSON.stringify(clients));
    form.set("auth", JSON.stringify(authEntries));
    form.set("intent", list ? "update" : "create");
    if (list) form.set("id", String(list.id));
    fetcher.submit(form, { method: "post" });
  };

  useEffect(() => {
    if (fetcher.data?.error) {
      toast.error(fetcher.data.error);
    } else if (fetcher.data?.ok) {
      toast.success(list ? "Access list updated" : "Access list created");
      onBack();
    }
  }, [fetcher.data]);

  return (
    <div>
      <div className="mb-6">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
      </div>

      <Card glass>
        <CardHeader>
          <CardTitle>{list ? "Edit Access List" : "Create Access List"}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    name="name"
                    type="text"
                    required
                    defaultValue={list?.name ?? ""}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="satisfy">Satisfy</Label>
                  <select
                    id="satisfy"
                    name="satisfy"
                    defaultValue={list?.satisfy ?? "any"}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="any">Any</option>
                    <option value="all">All</option>
                  </select>
                </div>
              </div>

              <Separator />

              <div>
                <h3 className="text-lg font-semibold mb-3">IP Rules</h3>
                <div className="space-y-2">
                  {clients.map((client, i) => (
                    <div key={i} className="flex gap-2">
                      <Input
                        type="text"
                        value={client.address}
                        onChange={(e) =>
                          setClients(
                            clients.map((c, ci) =>
                              ci === i ? { ...c, address: e.target.value } : c
                            )
                          )
                        }
                        placeholder="192.168.1.0/24"
                        className="flex-1"
                      />
                      <select
                        value={client.directive}
                        onChange={(e) =>
                          setClients(
                            clients.map((c, ci) =>
                              ci === i ? { ...c, directive: e.target.value } : c
                            )
                          )
                        }
                        className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <option value="allow">Allow</option>
                        <option value="deny">Deny</option>
                      </select>
                      {clients.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeClient(i)}
                          className="h-10 w-10 p-0 text-destructive hover:text-destructive"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addClient}
                  className="mt-2"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add IP Rule
                </Button>
              </div>

              <Separator />

              <div>
                <h3 className="text-lg font-semibold mb-3">Basic Auth</h3>
                <div className="space-y-2">
                  {authEntries.map((auth, i) => (
                    <div key={i} className="flex gap-2">
                      <Input
                        type="text"
                        value={auth.username}
                        onChange={(e) =>
                          setAuthEntries(
                            authEntries.map((a, ai) =>
                              ai === i ? { ...a, username: e.target.value } : a
                            )
                          )
                        }
                        placeholder="Username"
                        className="flex-1"
                      />
                      <Input
                        type="password"
                        value={auth.password}
                        onChange={(e) =>
                          setAuthEntries(
                            authEntries.map((a, ai) =>
                              ai === i ? { ...a, password: e.target.value } : a
                            )
                          )
                        }
                        placeholder={list ? "Leave blank to keep" : "Password"}
                        className="flex-1"
                      />
                      {authEntries.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeAuth(i)}
                          className="h-10 w-10 p-0 text-destructive hover:text-destructive"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addAuth}
                  className="mt-2"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add Auth Entry
                </Button>
              </div>
            </div>

            <Separator className="my-6" />

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onBack}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting} className="press-effect">
                {list ? "Update" : "Create"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
