import type { Route } from "./+types/users";
import { useFetcher } from "react-router";
import { db } from "~/lib/db/connection";
import { users } from "~/lib/db/schema";
import { eq } from "drizzle-orm";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { requireAdmin } from "~/lib/auth/middleware";
import { logAudit } from "~/lib/audit/log";
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
import { Plus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { PageHeader } from "~/components/PageHeader";

export function meta() {
  return [{ title: "Users — Nginx Manager" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUser = await requireAdmin(request);
  const allUsers = db.select().from(users).all();
  return {
    currentUserId: currentUser.userId,
    users: allUsers.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      mustChangePassword: u.mustChangePassword,
      createdAt: u.createdAt,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const currentUser = await requireAdmin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const ipAddress = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || "unknown";

  if (intent === "create") {
    const email = (formData.get("email") as string)?.trim();
    const name = (formData.get("name") as string)?.trim();
    const password = formData.get("password") as string;
    const role = formData.get("role") as string;

    if (!email || !name || !password) {
      return { error: "All fields are required" };
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { error: "Invalid email format" };
    }

    if (password.length < 8) {
      return { error: "Password must be at least 8 characters" };
    }

    const existing = db.select().from(users).where(eq(users.email, email)).get();
    if (existing) {
      return { error: "A user with this email already exists" };
    }

    const hashedPassword = await Bun.password.hash(password, {
      algorithm: "argon2id",
    });

    const result = db.insert(users)
      .values({
        email,
        name,
        password: hashedPassword,
        role: role as "admin" | "editor" | "viewer",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning()
      .get();

    logAudit({
      userId: currentUser.userId,
      action: "create",
      entity: "user",
      entityId: result.id,
      details: { email, role },
      ipAddress,
    });
  } else if (intent === "update") {
    const id = Number(formData.get("id"));
    const email = (formData.get("email") as string)?.trim();
    const name = (formData.get("name") as string)?.trim();
    const password = formData.get("password") as string;
    const role = formData.get("role") as string;

    if (!email || !name) {
      return { error: "Email and name are required" };
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { error: "Invalid email format" };
    }

    const existing = db.select().from(users).where(eq(users.email, email)).get();
    if (existing && existing.id !== id) {
      return { error: "A user with this email already exists" };
    }

    if (password && password.length < 8) {
      return { error: "Password must be at least 8 characters" };
    }

    const isSelf = id === currentUser.userId;

    const updateData: Record<string, unknown> = {
      email,
      name,
      updatedAt: new Date(),
    };

    if (!isSelf) {
      updateData.role = role as "admin" | "editor" | "viewer";
    }

    if (password) {
      updateData.password = await Bun.password.hash(password, {
        algorithm: "argon2id",
      });
    }

    db.update(users)
      .set(updateData)
      .where(eq(users.id, id))
      .run();

    logAudit({
      userId: currentUser.userId,
      action: "update",
      entity: "user",
      entityId: id,
      details: { email, role },
      ipAddress,
    });
  } else if (intent === "delete") {
    const id = Number(formData.get("id"));

    if (id === currentUser.userId) {
      return { error: "You cannot delete your own account" };
    }

    db.delete(users).where(eq(users.id, id)).run();

    logAudit({
      userId: currentUser.userId,
      action: "delete",
      entity: "user",
      entityId: id,
      ipAddress,
    });
  }

  return { ok: true };
}

export default function UsersPage({ loaderData }: Route.ComponentProps) {
  const { users: userList, currentUserId } = loaderData;
  const [showModal, setShowModal] = useState(false);
  const [editUser, setEditUser] = useState<(typeof userList)[0] | null>(null);

  const openCreate = () => {
    setEditUser(null);
    setShowModal(true);
  };

  const openEdit = (user: (typeof userList)[0]) => {
    setEditUser(user);
    setShowModal(true);
  };

  return (
    <div>
      <PageHeader
        title="Users"
        description="Manage user accounts and roles"
        actions={
          <Button onClick={openCreate} className="press-effect">
            <Plus className="mr-2 h-4 w-4" />
            Add User
          </Button>
        }
      />

      {userList.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-muted-foreground">
          No users found.
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[70px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {userList.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  onEdit={() => openEdit(user)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <UserModal
        user={editUser}
        open={showModal}
        onClose={() => setShowModal(false)}
        isSelf={editUser?.id === currentUserId}
      />
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  switch (role) {
    case "admin":
      return <Badge variant="destructive">admin</Badge>;
    case "editor":
      return <Badge>editor</Badge>;
    case "viewer":
    default:
      return <Badge variant="secondary">viewer</Badge>;
  }
}

function UserRow({
  user,
  onEdit,
}: {
  user: {
    id: number;
    name: string;
    email: string;
    role: string;
    createdAt: Date;
  };
  onEdit: () => void;
}) {
  const deleteFetcher = useFetcher();
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <TableRow className="hover:bg-muted/30 transition-colors">
      <TableCell className="font-medium">{user.name}</TableCell>
      <TableCell>{user.email}</TableCell>
      <TableCell>
        <RoleBadge role={user.role} />
      </TableCell>
      <TableCell>{new Date(user.createdAt).toLocaleDateString()}</TableCell>
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
                Are you sure you want to delete user &quot;{user.name}&quot;? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  deleteFetcher.submit(
                    { intent: "delete", id: String(user.id) },
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

function UserModal({
  user,
  open,
  onClose,
  isSelf,
}: {
  user: { id: number; name: string; email: string; role: string } | null;
  open: boolean;
  onClose: () => void;
  isSelf: boolean;
}) {
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state !== "idle";

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = (form.elements.namedItem("name") as HTMLInputElement).value.trim();
    const email = (form.elements.namedItem("email") as HTMLInputElement).value.trim();
    const password = (form.elements.namedItem("password") as HTMLInputElement).value;

    if (!name) {
      toast.error("Name is required");
      return;
    }

    if (!email) {
      toast.error("Email is required");
      return;
    }

    if (!emailRegex.test(email)) {
      toast.error("Invalid email format");
      return;
    }

    if (!user && !password) {
      toast.error("Password is required");
      return;
    }

    if (password && password.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }

    fetcher.submit(new FormData(form), { method: "post" });
  };

  useEffect(() => {
    if (fetcher.data?.error) {
      toast.error(fetcher.data.error);
    } else if (fetcher.data?.ok) {
      toast.success(user ? "User updated" : "User created");
      onClose();
    }
  }, [fetcher.data]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{user ? "Edit User" : "Create User"}</DialogTitle>
        </DialogHeader>
        <form method="post" onSubmit={handleSubmit}>
          <input type="hidden" name="intent" value={user ? "update" : "create"} />
          {user && <input type="hidden" name="id" value={String(user.id)} />}

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                type="text"
                required
                defaultValue={user?.name ?? ""}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                defaultValue={user?.email ?? ""}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">
                Password {user && "(leave blank to keep current)"}
              </Label>
              <Input
                id="password"
                name="password"
                type="password"
                required={!user}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              {isSelf && <input type="hidden" name="role" value={user?.role} />}
              <select
                id="role"
                name={isSelf ? undefined : "role"}
                defaultValue={user?.role ?? "viewer"}
                disabled={isSelf}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="admin">Admin</option>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
              {isSelf && (
                <p className="text-xs text-muted-foreground">
                  You cannot change your own role.
                </p>
              )}
            </div>
          </div>

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting} className="press-effect">
              {user ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
