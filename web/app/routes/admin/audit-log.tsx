import type { Route } from "./+types/audit-log";
import { Form, useSearchParams } from "react-router";
import { db } from "~/lib/db/connection";
import { auditLog, users } from "~/lib/db/schema";
import { desc, eq, and, gte, lte } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { PageHeader } from "~/components/PageHeader";

export function meta() {
  return [{ title: "Audit Log — Nginx Manager" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const actionFilter = url.searchParams.get("action") || "";
  const entityFilter = url.searchParams.get("entity") || "";
  const dateFrom = url.searchParams.get("dateFrom") || "";
  const dateTo = url.searchParams.get("dateTo") || "";

  const conditions = [];
  if (actionFilter) {
    conditions.push(eq(auditLog.action, actionFilter as any));
  }
  if (entityFilter) {
    conditions.push(eq(auditLog.entity, entityFilter));
  }
  if (dateFrom) {
    conditions.push(gte(auditLog.createdAt, new Date(dateFrom)));
  }
  if (dateTo) {
    const endDate = new Date(dateTo);
    endDate.setHours(23, 59, 59, 999);
    conditions.push(lte(auditLog.createdAt, endDate));
  }

  const query =
    conditions.length > 0
      ? db
          .select()
          .from(auditLog)
          .where(and(...conditions))
          .orderBy(desc(auditLog.createdAt))
          .limit(200)
          .all()
      : db
          .select()
          .from(auditLog)
          .orderBy(desc(auditLog.createdAt))
          .limit(200)
          .all();

  const allUsers = db.select().from(users).all();
  const userMap = new Map(allUsers.map((u) => [u.id, u.email]));

  const entries = query.map((entry) => ({
    ...entry,
    userEmail: entry.userId ? userMap.get(entry.userId) ?? "Unknown" : "System",
  }));

  return { entries };
}

export default function AuditLogPage({ loaderData }: Route.ComponentProps) {
  const { entries } = loaderData;
  const [searchParams] = useSearchParams();

  return (
    <div>
      <PageHeader
        title="Audit Log"
        description="Track user actions and system events"
      />

      <Card glass className="mb-6">
        <CardContent className="p-4">
          <Form method="get" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 items-end">
            <div>
              <Label htmlFor="action">Action</Label>
              <select
                id="action"
                name="action"
                defaultValue={searchParams.get("action") ?? ""}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring mt-1"
              >
                <option value="">All</option>
                <option value="create">Create</option>
                <option value="update">Update</option>
                <option value="delete">Delete</option>
                <option value="login">Login</option>
                <option value="logout">Logout</option>
                <option value="reload">Reload</option>
              </select>
            </div>

            <div>
              <Label htmlFor="entity">Entity</Label>
              <Input
                id="entity"
                name="entity"
                defaultValue={searchParams.get("entity") ?? ""}
                placeholder="e.g. proxy_host"
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="dateFrom">From</Label>
              <Input
                id="dateFrom"
                name="dateFrom"
                type="date"
                defaultValue={searchParams.get("dateFrom") ?? ""}
                className="mt-1"
              />
            </div>

            <div>
              <Label htmlFor="dateTo">To</Label>
              <Input
                id="dateTo"
                name="dateTo"
                type="date"
                defaultValue={searchParams.get("dateTo") ?? ""}
                className="mt-1"
              />
            </div>

            <Button type="submit" className="press-effect">Filter</Button>
          </Form>
        </CardContent>
      </Card>

      {entries.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No audit log entries found.
          </CardContent>
        </Card>
      ) : (
        <Card glass>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Entity ID</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id} className="hover:bg-muted/30 transition-colors">
                  <TableCell className="whitespace-nowrap">
                    {entry.createdAt
                      ? new Date(entry.createdAt).toLocaleString()
                      : "-"}
                  </TableCell>
                  <TableCell>{entry.userEmail}</TableCell>
                  <TableCell>
                    <ActionBadge action={entry.action} />
                  </TableCell>
                  <TableCell>{entry.entity}</TableCell>
                  <TableCell>{entry.entityId ?? "-"}</TableCell>
                  <TableCell className="max-w-xs truncate">
                    {entry.details ? JSON.stringify(entry.details) : "-"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  switch (action) {
    case "create":
      return (
        <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30">
          {action}
        </Badge>
      );
    case "update":
      return <Badge variant="secondary">{action}</Badge>;
    case "delete":
      return <Badge variant="destructive">{action}</Badge>;
    case "login":
      return (
        <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30">
          {action}
        </Badge>
      );
    case "logout":
      return <Badge variant="secondary">{action}</Badge>;
    case "reload":
      return (
        <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
          {action}
        </Badge>
      );
    default:
      return <Badge variant="outline">{action}</Badge>;
  }
}
