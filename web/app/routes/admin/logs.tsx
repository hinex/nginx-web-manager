import type { Route } from "./+types/logs";
import { db } from "~/lib/db/connection";
import { hosts } from "~/lib/db/schema";
import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { RefreshCw, Search } from "lucide-react";
import { PageHeader } from "~/components/PageHeader";

export function meta() {
  return [{ title: "Logs — Nginx Manager" }];
}

export async function loader({}: Route.LoaderArgs) {
  const allHosts = db.select().from(hosts).all();
  return {
    hosts: allHosts.map((h) => ({
      id: h.id,
      domains: h.domains as string[],
    })),
  };
}

export default function LogsPage({ loaderData }: Route.ComponentProps) {
  const { hosts } = loaderData;
  const [selectedHost, setSelectedHost] = useState("");
  const [tab, setTab] = useState<"access" | "error">("access");
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchLogs = useCallback(async () => {
    if (!selectedHost) {
      setLines([]);
      return;
    }
    try {
      const res = await fetch(
        `/api/logs?hostId=${selectedHost}&type=${tab}&lines=100`
      );
      const data = await res.json();
      setLines(data.lines ?? []);
    } catch {
      setLines([]);
    }
  }, [selectedHost, tab]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchLogs]);

  const filteredLines = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  return (
    <div>
      <PageHeader
        title="Logs"
        description="Real-time nginx access and error logs"
      />

      <Card glass>
        <CardContent className="p-6">
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-3 sm:gap-4 mb-4">
            <div>
              <Label htmlFor="host">Host</Label>
              <select
                id="host"
                value={selectedHost}
                onChange={(e) => setSelectedHost(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring mt-1"
              >
                <option value="">Select a host</option>
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.domains.join(", ")}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label>Log Type</Label>
              <Tabs
                value={tab}
                onValueChange={(v) => setTab(v as "access" | "error")}
                className="mt-1"
              >
                <TabsList>
                  <TabsTrigger value="access">Access</TabsTrigger>
                  <TabsTrigger value="error">Error</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            <div>
              <Label htmlFor="filter">Filter</Label>
              <div className="relative mt-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Search logs..."
                  className="pl-9"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="auto-refresh"
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
              />
              <Label htmlFor="auto-refresh">Auto-refresh (5s)</Label>
            </div>

            <Button variant="outline" size="sm" onClick={fetchLogs}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>

          <div className="rounded-md bg-[oklch(0.1_0_0)] text-emerald-400 p-4 font-mono text-xs overflow-x-auto max-h-[600px] overflow-y-auto">
            {filteredLines.length === 0 ? (
              <div className="text-muted-foreground">
                {selectedHost
                  ? "No log entries found."
                  : "Select a host to view logs."}
              </div>
            ) : (
              filteredLines.map((line, i) => (
                <div key={i} className="whitespace-pre hover:bg-white/5">
                  {line}
                </div>
              ))
            )}
          </div>

          <p className="mt-2 text-sm text-muted-foreground">
            Showing {filteredLines.length} of {lines.length} lines
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
